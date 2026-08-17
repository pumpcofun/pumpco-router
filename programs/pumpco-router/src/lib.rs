//! pumpco router.
//!
//! Every trade the company's machines make goes through here, on the bonding
//! curve before a mint graduates and on PumpSwap after. It exists so the
//! spending limits are enforced by the chain rather than by the process that
//! talks to the model. An agent whose context has been poisoned can still sign
//! whatever it likes; it cannot exceed a per-trade cap, cannot exceed a daily
//! budget, cannot route to a program that is not pump.fun, cannot redirect the
//! fee, and cannot spend another agent's budget.
//!
//! The router never takes custody. The agent signs the outer transaction and
//! stays the `user` on the inner instruction, so value moves directly between
//! the agent and the venue.

use anchor_lang::prelude::*;

pub mod amm;
pub mod curve;
pub mod guards;
pub mod rewards;
pub mod state;

use crate::rewards::CreatorVault;
use crate::state::*;

// Anchor generates its client account helpers beside the struct definition and
// then looks for them at the crate root, so the account structs have to be
// re-exported here even though they live in submodules.




declare_id!("pumpcoEZJNNneH9KjrpBSVCKpADVgJpBbtkGvbtFbuy");

#[program]
pub mod pumpco_router {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, args: ConfigArgs) -> Result<()> {
        args.validate()?;
        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.treasury = ctx.accounts.treasury.key();
        config.fee_vault = ctx.accounts.fee_vault.key();
        config.fee_bps = args.fee_bps;
        config.max_lamports_per_trade = args.max_lamports_per_trade;
        config.default_daily_limit = args.default_daily_limit;
        config.paused = false;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn update_config(ctx: Context<UpdateConfig>, args: ConfigArgs) -> Result<()> {
        args.validate()?;
        let config = &mut ctx.accounts.config;
        config.treasury = ctx.accounts.treasury.key();
        config.fee_vault = ctx.accounts.fee_vault.key();
        config.fee_bps = args.fee_bps;
        config.max_lamports_per_trade = args.max_lamports_per_trade;
        config.default_daily_limit = args.default_daily_limit;
        Ok(())
    }

    pub fn set_paused(ctx: Context<UpdateConfig>, paused: bool) -> Result<()> {
        ctx.accounts.config.paused = paused;
        Ok(())
    }

    /// Creates the address to hand pump.fun as `creator` at token launch.
    pub fn init_creator_vault(ctx: Context<InitCreatorVault>) -> Result<()> {
        ctx.accounts.creator_vault.bump = ctx.bumps.creator_vault;
        Ok(())
    }

    /// Company machine. Limits are set by the authority and the agent cannot
    /// raise them.
    pub fn register_agent(
        ctx: Context<RegisterAgent>,
        daily_limit: u64,
        reward_bps: u16,
    ) -> Result<()> {
        require!(
            reward_bps as u64 <= BPS_DENOMINATOR,
            RouterError::RewardSharesTooHigh
        );
        let agent = &mut ctx.accounts.agent_auth;
        agent.wallet = ctx.accounts.wallet.key();
        agent.daily_limit = daily_limit;
        agent.spent_today = 0;
        agent.day = guards::current_day()?;
        agent.reward_bps = reward_bps;
        agent.enabled = true;
        agent.authority_managed = true;
        agent.bump = ctx.bumps.agent_auth;
        Ok(())
    }

    /// Anyone may register themselves and route trades through pumpco. They set
    /// their own ceiling because it is their own money; they get no share of
    /// creator rewards.
    pub fn self_register(ctx: Context<SelfRegister>, daily_limit: u64) -> Result<()> {
        let cap = ctx.accounts.config.default_daily_limit;
        let agent = &mut ctx.accounts.agent_auth;
        agent.wallet = ctx.accounts.wallet.key();
        agent.daily_limit = if cap > 0 { daily_limit.min(cap) } else { daily_limit };
        agent.spent_today = 0;
        agent.day = guards::current_day()?;
        agent.reward_bps = 0;
        agent.enabled = true;
        agent.authority_managed = false;
        agent.bump = ctx.bumps.agent_auth;
        Ok(())
    }

    pub fn set_agent(
        ctx: Context<SetAgent>,
        enabled: bool,
        daily_limit: u64,
        reward_bps: u16,
    ) -> Result<()> {
        require!(
            reward_bps as u64 <= BPS_DENOMINATOR,
            RouterError::RewardSharesTooHigh
        );
        let agent = &mut ctx.accounts.agent_auth;
        agent.enabled = enabled;
        agent.daily_limit = daily_limit;
        agent.reward_bps = reward_bps;
        Ok(())
    }

    /// A wallet that registered itself may adjust its own ceiling.
    pub fn set_own_limit(ctx: Context<SetOwnLimit>, daily_limit: u64) -> Result<()> {
        let agent = &mut ctx.accounts.agent_auth;
        require!(!agent.authority_managed, RouterError::AuthorityManaged);
        agent.daily_limit = daily_limit;
        Ok(())
    }

    // ---- bonding curve ----

    /// `track_volume` is optional in pump.fun's IDL and real mainnet buys omit
    /// it, so the payload is exactly 24 bytes. Sending a trailing byte would not
    /// match any transaction known to work.
    pub fn buy<'info>(
        mut ctx: Context<'_, '_, '_, 'info, TradeCurve<'info>>,
        amount: u64,
        max_sol_cost: u64,
    ) -> Result<()> {
        let mut data = Vec::with_capacity(24);
        data.extend_from_slice(&BUY_DISCRIMINATOR);
        data.extend_from_slice(&amount.to_le_bytes());
        data.extend_from_slice(&max_sol_cost.to_le_bytes());
        curve::route(&mut ctx.accounts, ctx.remaining_accounts, max_sol_cost, Side::Buy, data)
    }

    pub fn sell<'info>(
        mut ctx: Context<'_, '_, '_, 'info, TradeCurve<'info>>,
        amount: u64,
        min_sol_output: u64,
    ) -> Result<()> {
        let mut data = Vec::with_capacity(24);
        data.extend_from_slice(&SELL_DISCRIMINATOR);
        data.extend_from_slice(&amount.to_le_bytes());
        data.extend_from_slice(&min_sol_output.to_le_bytes());
        curve::route(&mut ctx.accounts, ctx.remaining_accounts, 0, Side::Sell, data)
    }

    // ---- PumpSwap, after graduation ----

    /// Unlike the curve, live PumpSwap buys do send `track_volume`, and it goes
    /// on the wire as a borsh Option: `[0]` for none, `[1, 0]` for Some(false).
    /// It stays an argument so the encoding can be corrected without redeploying.
    pub fn buy_amm<'info>(
        mut ctx: Context<'_, '_, '_, 'info, TradeAmm<'info>>,
        base_amount_out: u64,
        max_quote_amount_in: u64,
        track_volume: Option<bool>,
    ) -> Result<()> {
        let mut data = Vec::with_capacity(26);
        data.extend_from_slice(&BUY_DISCRIMINATOR);
        data.extend_from_slice(&base_amount_out.to_le_bytes());
        data.extend_from_slice(&max_quote_amount_in.to_le_bytes());
        track_volume.serialize(&mut data)?;
        amm::route(&mut ctx.accounts, ctx.remaining_accounts, max_quote_amount_in, Side::Buy, data)
    }

    pub fn sell_amm<'info>(
        mut ctx: Context<'_, '_, '_, 'info, TradeAmm<'info>>,
        base_amount_in: u64,
        min_quote_amount_out: u64,
    ) -> Result<()> {
        let mut data = Vec::with_capacity(24);
        data.extend_from_slice(&SELL_DISCRIMINATOR);
        data.extend_from_slice(&base_amount_in.to_le_bytes());
        data.extend_from_slice(&min_quote_amount_out.to_le_bytes());
        amm::route(&mut ctx.accounts, ctx.remaining_accounts, 0, Side::Sell, data)
    }

    /// Permissionless. Pair this with pump.fun's `collect_creator_fee`, which
    /// also needs no signature, and the whole reward path runs without a key.
    pub fn distribute_rewards<'info>(
        ctx: Context<'_, '_, '_, 'info, Distribute<'info>>,
    ) -> Result<()> {
        rewards::distribute(
            ctx.program_id,
            ctx.accounts.creator_vault.to_account_info(),
            ctx.accounts.treasury.to_account_info(),
            ctx.remaining_accounts,
        )
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = authority, space = Config::LEN, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,

    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: destination for router fees; only its address is stored.
    pub fee_vault: UncheckedAccount<'info>,
    /// CHECK: receives the unassigned share of creator rewards.
    pub treasury: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump,
        has_one = authority @ RouterError::Unauthorized
    )]
    pub config: Account<'info, Config>,

    pub authority: Signer<'info>,

    /// CHECK: destination for router fees; only its address is stored.
    pub fee_vault: UncheckedAccount<'info>,
    /// CHECK: receives the unassigned share of creator rewards.
    pub treasury: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct RegisterAgent<'info> {
    #[account(
        seeds = [b"config"],
        bump = config.bump,
        has_one = authority @ RouterError::Unauthorized
    )]
    pub config: Account<'info, Config>,

    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: the wallet being granted trading rights; only its address is stored.
    pub wallet: UncheckedAccount<'info>,

    #[account(
        init,
        payer = authority,
        space = AgentAuth::LEN,
        seeds = [b"agent", wallet.key().as_ref()],
        bump
    )]
    pub agent_auth: Account<'info, AgentAuth>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SelfRegister<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    /// Signs for itself, so nobody can register a wallet they do not control.
    #[account(mut)]
    pub wallet: Signer<'info>,

    #[account(
        init,
        payer = wallet,
        space = AgentAuth::LEN,
        seeds = [b"agent", wallet.key().as_ref()],
        bump
    )]
    pub agent_auth: Account<'info, AgentAuth>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetAgent<'info> {
    #[account(
        seeds = [b"config"],
        bump = config.bump,
        has_one = authority @ RouterError::Unauthorized
    )]
    pub config: Account<'info, Config>,

    pub authority: Signer<'info>,

    #[account(mut, seeds = [b"agent", agent_auth.wallet.as_ref()], bump = agent_auth.bump)]
    pub agent_auth: Account<'info, AgentAuth>,
}

#[derive(Accounts)]
pub struct SetOwnLimit<'info> {
    pub wallet: Signer<'info>,

    #[account(mut, seeds = [b"agent", wallet.key().as_ref()], bump = agent_auth.bump)]
    pub agent_auth: Account<'info, AgentAuth>,
}
#[derive(Accounts)]
pub struct TradeCurve<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    /// Seeding this PDA with the signer is what stops one agent spending
    /// another agent's budget.
    #[account(mut, seeds = [b"agent", agent.key().as_ref()], bump = agent_auth.bump)]
    pub agent_auth: Account<'info, AgentAuth>,

    #[account(mut)]
    pub agent: Signer<'info>,

    #[account(mut, address = config.fee_vault @ RouterError::WrongFeeVault)]
    /// CHECK: pinned to the configured vault.
    pub fee_vault: UncheckedAccount<'info>,

    #[account(address = PUMP_PROGRAM @ RouterError::WrongProgram)]
    /// CHECK: pinned; this is the CPI target.
    pub pump_program: UncheckedAccount<'info>,

    // Forwarded untouched. pump.fun validates its own PDAs with its own seeds,
    // so re-deriving them here would add surface area, not a guarantee.
    /// CHECK: validated by pump.fun.
    pub global: UncheckedAccount<'info>,
    #[account(mut)]
    /// CHECK: validated by pump.fun.
    pub fee_recipient: UncheckedAccount<'info>,
    /// CHECK: validated by pump.fun.
    pub mint: UncheckedAccount<'info>,
    #[account(mut)]
    /// CHECK: validated by pump.fun; we read only `complete`.
    pub bonding_curve: UncheckedAccount<'info>,
    #[account(mut)]
    /// CHECK: validated by pump.fun.
    pub associated_bonding_curve: UncheckedAccount<'info>,
    #[account(mut)]
    /// CHECK: validated by pump.fun.
    pub associated_user: UncheckedAccount<'info>,
    #[account(mut)]
    /// CHECK: validated by pump.fun.
    pub creator_vault: UncheckedAccount<'info>,
    /// CHECK: validated by pump.fun.
    pub event_authority: UncheckedAccount<'info>,
    /// CHECK: validated by pump.fun.
    pub global_volume_accumulator: UncheckedAccount<'info>,
    #[account(mut)]
    /// CHECK: validated by pump.fun.
    pub user_volume_accumulator: UncheckedAccount<'info>,
    /// CHECK: validated by pump.fun.
    pub fee_config: UncheckedAccount<'info>,
    /// CHECK: validated by pump.fun.
    pub fee_program: UncheckedAccount<'info>,
    /// CHECK: token program, validated by pump.fun.
    pub token_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct TradeAmm<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(mut, seeds = [b"agent", agent.key().as_ref()], bump = agent_auth.bump)]
    pub agent_auth: Account<'info, AgentAuth>,

    #[account(mut)]
    pub agent: Signer<'info>,

    #[account(mut, address = config.fee_vault @ RouterError::WrongFeeVault)]
    /// CHECK: pinned to the configured vault.
    pub fee_vault: UncheckedAccount<'info>,

    #[account(address = PUMP_AMM_PROGRAM @ RouterError::WrongProgram)]
    /// CHECK: pinned; this is the CPI target.
    pub amm_program: UncheckedAccount<'info>,

    #[account(mut)]
    /// CHECK: validated by PumpSwap.
    pub pool: UncheckedAccount<'info>,
    /// CHECK: validated by PumpSwap.
    pub global_config: UncheckedAccount<'info>,
    /// CHECK: validated by PumpSwap.
    pub base_mint: UncheckedAccount<'info>,
    /// CHECK: validated by PumpSwap.
    pub quote_mint: UncheckedAccount<'info>,
    #[account(mut)]
    /// CHECK: validated by PumpSwap.
    pub user_base_token_account: UncheckedAccount<'info>,
    #[account(mut)]
    /// CHECK: validated by PumpSwap; we read only its `amount`.
    pub user_quote_token_account: UncheckedAccount<'info>,
    #[account(mut)]
    /// CHECK: validated by PumpSwap.
    pub pool_base_token_account: UncheckedAccount<'info>,
    #[account(mut)]
    /// CHECK: validated by PumpSwap.
    pub pool_quote_token_account: UncheckedAccount<'info>,
    /// CHECK: validated by PumpSwap.
    pub protocol_fee_recipient: UncheckedAccount<'info>,
    #[account(mut)]
    /// CHECK: validated by PumpSwap.
    pub protocol_fee_recipient_token_account: UncheckedAccount<'info>,
    /// CHECK: validated by PumpSwap.
    pub base_token_program: UncheckedAccount<'info>,
    /// CHECK: validated by PumpSwap.
    pub quote_token_program: UncheckedAccount<'info>,
    /// CHECK: validated by PumpSwap.
    pub associated_token_program: UncheckedAccount<'info>,
    /// CHECK: validated by PumpSwap.
    pub event_authority: UncheckedAccount<'info>,
    #[account(mut)]
    /// CHECK: validated by PumpSwap.
    pub coin_creator_vault_ata: UncheckedAccount<'info>,
    /// CHECK: validated by PumpSwap.
    pub coin_creator_vault_authority: UncheckedAccount<'info>,
    /// CHECK: validated by PumpSwap.
    pub global_volume_accumulator: UncheckedAccount<'info>,
    #[account(mut)]
    /// CHECK: validated by PumpSwap.
    pub user_volume_accumulator: UncheckedAccount<'info>,
    /// CHECK: validated by PumpSwap.
    pub fee_config: UncheckedAccount<'info>,
    /// CHECK: validated by PumpSwap.
    pub fee_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitCreatorVault<'info> {
    #[account(
        seeds = [b"config"],
        bump = config.bump,
        has_one = authority @ RouterError::Unauthorized
    )]
    pub config: Account<'info, Config>,

    #[account(mut)]
    pub authority: Signer<'info>,

    /// The address to pass as `creator` when the token is created on pump.fun.
    #[account(
        init,
        payer = authority,
        space = CreatorVault::LEN,
        seeds = [b"creator"],
        bump
    )]
    pub creator_vault: Account<'info, CreatorVault>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Distribute<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(mut, seeds = [b"creator"], bump = creator_vault.bump)]
    pub creator_vault: Account<'info, CreatorVault>,

    #[account(mut, address = config.treasury @ RouterError::WrongTreasury)]
    /// CHECK: pinned to the configured treasury.
    pub treasury: UncheckedAccount<'info>,
    // remaining_accounts: (agent_auth, wallet) pairs, in any order.
}
