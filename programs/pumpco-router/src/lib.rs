//! PumpCo router.
//!
//! Every agent trade on pump.fun goes through this program. It exists so that
//! the spending limits are enforced by the chain rather than by the Node process
//! that talks to the model. An agent whose context has been poisoned can still
//! sign whatever it likes; it cannot exceed a per-trade cap, cannot exceed a
//! daily cap, cannot route to a program that is not pump.fun, and cannot trade
//! on behalf of another agent. Those are the four things that actually matter.
//!
//! The router never takes custody. The agent signs the outer transaction and
//! remains the `user` on the inner pump.fun instruction, so funds move directly
//! between the agent and the bonding curve.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke,
    system_instruction,
};

declare_id!("pumpcoEZJNNneH9KjrpBSVCKpADVgJpBbtkGvbtFbuy");

/// pump.fun bonding curve program on mainnet. Hardcoded on purpose: the CPI
/// target is the one thing a caller must never be able to choose.
pub const PUMP_PROGRAM: Pubkey = pubkey!("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

/// Anchor discriminators read from pump.fun's on-chain IDL.
pub const BUY_DISCRIMINATOR: [u8; 8] = [102, 6, 61, 18, 1, 218, 235, 234];
pub const SELL_DISCRIMINATOR: [u8; 8] = [51, 230, 133, 164, 1, 127, 131, 173];

/// Hard ceiling on the router fee. The authority cannot set a fee above this,
/// so a compromised admin key still cannot confiscate a trade.
pub const MAX_FEE_BPS: u16 = 300;

pub const SECONDS_PER_DAY: i64 = 86_400;

#[program]
pub mod pumpco_router {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, args: ConfigArgs) -> Result<()> {
        args.validate()?;

        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.fee_vault = ctx.accounts.fee_vault.key();
        config.fee_bps = args.fee_bps;
        config.max_lamports_per_trade = args.max_lamports_per_trade;
        config.paused = false;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn update_config(ctx: Context<UpdateConfig>, args: ConfigArgs) -> Result<()> {
        args.validate()?;

        let config = &mut ctx.accounts.config;
        config.fee_vault = ctx.accounts.fee_vault.key();
        config.fee_bps = args.fee_bps;
        config.max_lamports_per_trade = args.max_lamports_per_trade;
        Ok(())
    }

    pub fn set_paused(ctx: Context<UpdateConfig>, paused: bool) -> Result<()> {
        ctx.accounts.config.paused = paused;
        Ok(())
    }

    /// Authority hands a wallet permission to trade, with its own daily ceiling.
    pub fn register_agent(ctx: Context<RegisterAgent>, daily_limit: u64) -> Result<()> {
        let agent = &mut ctx.accounts.agent_auth;
        agent.wallet = ctx.accounts.wallet.key();
        agent.daily_limit = daily_limit;
        agent.spent_today = 0;
        agent.day = current_day()?;
        agent.enabled = true;
        agent.bump = ctx.bumps.agent_auth;
        Ok(())
    }

    pub fn set_agent(ctx: Context<SetAgent>, enabled: bool, daily_limit: u64) -> Result<()> {
        let agent = &mut ctx.accounts.agent_auth;
        agent.enabled = enabled;
        agent.daily_limit = daily_limit;
        Ok(())
    }

    /// Buy on the bonding curve. `amount` is tokens out, `max_sol_cost` is the
    /// agent's slippage ceiling and the number every limit is checked against,
    /// because it is the most the trade can possibly cost.
    /// `track_volume` is declared optional by pump.fun's IDL and real mainnet
    /// buys omit it entirely, so the payload is exactly 24 bytes. Appending a
    /// trailing byte here would not match any transaction that is known to work.
    pub fn buy<'info>(
        ctx: Context<'_, '_, '_, 'info, Trade<'info>>,
        amount: u64,
        max_sol_cost: u64,
    ) -> Result<()> {
        let mut data = Vec::with_capacity(24);
        data.extend_from_slice(&BUY_DISCRIMINATOR);
        data.extend_from_slice(&amount.to_le_bytes());
        data.extend_from_slice(&max_sol_cost.to_le_bytes());

        route(ctx, max_sol_cost, Side::Buy, data)
    }

    /// Sell on the bonding curve. The agent receives SOL, so no spend limit
    /// applies, but the fee is still taken and the trade is still attributed.
    pub fn sell<'info>(
        ctx: Context<'_, '_, '_, 'info, Trade<'info>>,
        amount: u64,
        min_sol_output: u64,
    ) -> Result<()> {
        let mut data = Vec::with_capacity(24);
        data.extend_from_slice(&SELL_DISCRIMINATOR);
        data.extend_from_slice(&amount.to_le_bytes());
        data.extend_from_slice(&min_sol_output.to_le_bytes());

        route(ctx, 0, Side::Sell, data)
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Side {
    Buy,
    Sell,
}

/// Shared path for both sides: check the limits, forward to pump.fun, take the
/// fee on whatever actually moved, record the trade.
fn route<'info>(
    ctx: Context<'_, '_, '_, 'info, Trade<'info>>,
    spend_ceiling: u64,
    side: Side,
    data: Vec<u8>,
) -> Result<()> {
    let fee_bps = ctx.accounts.config.fee_bps;
    let max_per_trade = ctx.accounts.config.max_lamports_per_trade;

    require!(!ctx.accounts.config.paused, RouterError::Paused);
    require!(ctx.accounts.agent_auth.enabled, RouterError::AgentDisabled);

    if side == Side::Buy {
        require!(spend_ceiling > 0, RouterError::ZeroAmount);
        require!(spend_ceiling <= max_per_trade, RouterError::TradeTooLarge);
        charge_daily_budget(&mut ctx.accounts.agent_auth, spend_ceiling)?;
    }

    let metas = pump_account_metas(&ctx, side);
    let infos = pump_account_infos(&ctx, side);

    let before = ctx.accounts.agent.lamports();

    invoke(
        &Instruction {
            program_id: PUMP_PROGRAM,
            accounts: metas,
            data,
        },
        &infos,
    )?;

    let after = ctx.accounts.agent.lamports();

    // Fee is charged on what the trade actually moved, not on the ceiling the
    // agent asked for, so unused slippage is never billed.
    let moved = match side {
        Side::Buy => before.saturating_sub(after),
        Side::Sell => after.saturating_sub(before),
    };

    let fee = (moved as u128)
        .checked_mul(fee_bps as u128)
        .ok_or(RouterError::MathOverflow)?
        .checked_div(10_000)
        .ok_or(RouterError::MathOverflow)? as u64;

    if fee > 0 {
        invoke(
            &system_instruction::transfer(
                &ctx.accounts.agent.key(),
                &ctx.accounts.fee_vault.key(),
                fee,
            ),
            &[
                ctx.accounts.agent.to_account_info(),
                ctx.accounts.fee_vault.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;
    }

    emit!(TradeRouted {
        agent: ctx.accounts.agent.key(),
        mint: ctx.accounts.mint.key(),
        is_buy: side == Side::Buy,
        lamports_moved: moved,
        fee_lamports: fee,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}

/// Roll the window if the day changed, then reserve against today's budget.
fn charge_daily_budget(agent: &mut Account<AgentAuth>, amount: u64) -> Result<()> {
    let today = current_day()?;
    if agent.day != today {
        agent.day = today;
        agent.spent_today = 0;
    }

    let spent = agent
        .spent_today
        .checked_add(amount)
        .ok_or(RouterError::MathOverflow)?;
    require!(spent <= agent.daily_limit, RouterError::DailyLimitExceeded);

    agent.spent_today = spent;
    Ok(())
}

fn current_day() -> Result<i64> {
    Ok(Clock::get()?.unix_timestamp / SECONDS_PER_DAY)
}

/// pump.fun's account order, taken from its IDL. Buy carries two accumulator
/// accounts that sell does not, and the two swap the order of `creator_vault`
/// and `token_program`.
fn pump_account_metas<'info>(
    ctx: &Context<'_, '_, '_, 'info, Trade<'info>>,
    side: Side,
) -> Vec<AccountMeta> {
    let a = &ctx.accounts;
    let mut metas = vec![
        AccountMeta::new_readonly(a.global.key(), false),
        AccountMeta::new(a.fee_recipient.key(), false),
        AccountMeta::new_readonly(a.mint.key(), false),
        AccountMeta::new(a.bonding_curve.key(), false),
        AccountMeta::new(a.associated_bonding_curve.key(), false),
        AccountMeta::new(a.associated_user.key(), false),
        AccountMeta::new(a.agent.key(), true),
        AccountMeta::new_readonly(a.system_program.key(), false),
    ];

    match side {
        Side::Buy => {
            metas.push(AccountMeta::new_readonly(a.token_program.key(), false));
            metas.push(AccountMeta::new(a.creator_vault.key(), false));
        }
        Side::Sell => {
            metas.push(AccountMeta::new(a.creator_vault.key(), false));
            metas.push(AccountMeta::new_readonly(a.token_program.key(), false));
        }
    }

    metas.push(AccountMeta::new_readonly(a.event_authority.key(), false));
    metas.push(AccountMeta::new_readonly(a.pump_program.key(), false));

    if side == Side::Buy {
        metas.push(AccountMeta::new_readonly(
            a.global_volume_accumulator.key(),
            false,
        ));
        metas.push(AccountMeta::new(a.user_volume_accumulator.key(), false));
    }

    metas.push(AccountMeta::new_readonly(a.fee_config.key(), false));
    metas.push(AccountMeta::new_readonly(a.fee_program.key(), false));

    // Real mainnet buys carry extra trailing accounts beyond the 16 in the IDL
    // (pump.fun's fee program reads them). Forward whatever the client sends so
    // we are not the reason a valid trade fails.
    for account in ctx.remaining_accounts.iter() {
        metas.push(if account.is_writable {
            AccountMeta::new(*account.key, account.is_signer)
        } else {
            AccountMeta::new_readonly(*account.key, account.is_signer)
        });
    }

    metas
}

fn pump_account_infos<'info>(
    ctx: &Context<'_, '_, '_, 'info, Trade<'info>>,
    side: Side,
) -> Vec<AccountInfo<'info>> {
    let a = &ctx.accounts;
    let mut infos = vec![
        a.global.to_account_info(),
        a.fee_recipient.to_account_info(),
        a.mint.to_account_info(),
        a.bonding_curve.to_account_info(),
        a.associated_bonding_curve.to_account_info(),
        a.associated_user.to_account_info(),
        a.agent.to_account_info(),
        a.system_program.to_account_info(),
    ];

    match side {
        Side::Buy => {
            infos.push(a.token_program.to_account_info());
            infos.push(a.creator_vault.to_account_info());
        }
        Side::Sell => {
            infos.push(a.creator_vault.to_account_info());
            infos.push(a.token_program.to_account_info());
        }
    }

    infos.push(a.event_authority.to_account_info());
    infos.push(a.pump_program.to_account_info());

    if side == Side::Buy {
        infos.push(a.global_volume_accumulator.to_account_info());
        infos.push(a.user_volume_accumulator.to_account_info());
    }

    infos.push(a.fee_config.to_account_info());
    infos.push(a.fee_program.to_account_info());
    infos.extend(ctx.remaining_accounts.iter().cloned());
    infos
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ConfigArgs {
    pub fee_bps: u16,
    pub max_lamports_per_trade: u64,
}

impl ConfigArgs {
    fn validate(&self) -> Result<()> {
        require!(self.fee_bps <= MAX_FEE_BPS, RouterError::FeeTooHigh);
        require!(
            self.max_lamports_per_trade > 0,
            RouterError::ZeroAmount
        );
        Ok(())
    }
}

#[account]
pub struct Config {
    pub authority: Pubkey,
    pub fee_vault: Pubkey,
    pub fee_bps: u16,
    pub max_lamports_per_trade: u64,
    pub paused: bool,
    pub bump: u8,
}

impl Config {
    pub const LEN: usize = 8 + 32 + 32 + 2 + 8 + 1 + 1;
}

#[account]
pub struct AgentAuth {
    pub wallet: Pubkey,
    pub daily_limit: u64,
    pub spent_today: u64,
    pub day: i64,
    pub enabled: bool,
    pub bump: u8,
}

impl AgentAuth {
    pub const LEN: usize = 8 + 32 + 8 + 8 + 8 + 1 + 1;
}

#[event]
pub struct TradeRouted {
    pub agent: Pubkey,
    pub mint: Pubkey,
    pub is_buy: bool,
    pub lamports_moved: u64,
    pub fee_lamports: u64,
    pub timestamp: i64,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = Config::LEN,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, Config>,

    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: destination for router fees; only its address is stored.
    pub fee_vault: UncheckedAccount<'info>,

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
pub struct SetAgent<'info> {
    #[account(
        seeds = [b"config"],
        bump = config.bump,
        has_one = authority @ RouterError::Unauthorized
    )]
    pub config: Account<'info, Config>,

    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"agent", agent_auth.wallet.as_ref()],
        bump = agent_auth.bump
    )]
    pub agent_auth: Account<'info, AgentAuth>,
}

#[derive(Accounts)]
pub struct Trade<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    /// Binding the PDA seed to the signer is what stops one agent trading on
    /// another agent's budget.
    #[account(
        mut,
        seeds = [b"agent", agent.key().as_ref()],
        bump = agent_auth.bump
    )]
    pub agent_auth: Account<'info, AgentAuth>,

    #[account(mut)]
    pub agent: Signer<'info>,

    #[account(mut, address = config.fee_vault @ RouterError::WrongFeeVault)]
    /// CHECK: address is pinned to the configured vault.
    pub fee_vault: UncheckedAccount<'info>,

    #[account(address = PUMP_PROGRAM @ RouterError::WrongProgram)]
    /// CHECK: pinned to pump.fun; this is the CPI target.
    pub pump_program: UncheckedAccount<'info>,

    // Everything below is forwarded to pump.fun untouched. pump.fun validates
    // its own PDAs with its own seeds, so re-deriving them here would add
    // surface area without adding a guarantee.
    /// CHECK: validated by pump.fun.
    pub global: UncheckedAccount<'info>,
    #[account(mut)]
    /// CHECK: validated by pump.fun.
    pub fee_recipient: UncheckedAccount<'info>,
    /// CHECK: validated by pump.fun.
    pub mint: UncheckedAccount<'info>,
    #[account(mut)]
    /// CHECK: validated by pump.fun.
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
    /// CHECK: SPL token program, validated by pump.fun.
    pub token_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[error_code]
pub enum RouterError {
    #[msg("router is paused")]
    Paused,
    #[msg("agent is not permitted to trade")]
    AgentDisabled,
    #[msg("trade exceeds the per-trade cap")]
    TradeTooLarge,
    #[msg("trade exceeds the agent's daily budget")]
    DailyLimitExceeded,
    #[msg("fee exceeds the hard ceiling")]
    FeeTooHigh,
    #[msg("amount must be greater than zero")]
    ZeroAmount,
    #[msg("fee vault does not match config")]
    WrongFeeVault,
    #[msg("CPI target is not pump.fun")]
    WrongProgram,
    #[msg("signer is not the configured authority")]
    Unauthorized,
    #[msg("arithmetic overflow")]
    MathOverflow,
}
