//! The checks that make this program worth deploying, shared by both venues.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke, system_instruction};

use crate::state::*;

pub fn current_day() -> Result<i64> {
    Ok(Clock::get()?.unix_timestamp / SECONDS_PER_DAY)
}

/// Roll the window if the day changed, then reserve against today's budget.
/// Reserving the slippage ceiling rather than the settled cost is deliberate:
/// the budget must be provably safe before the trade runs, not after.
pub fn charge_daily_budget(agent: &mut Account<AgentAuth>, amount: u64) -> Result<()> {
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

pub fn fee_for(moved: u64, fee_bps: u16) -> Result<u64> {
    Ok((moved as u128)
        .checked_mul(fee_bps as u128)
        .ok_or(RouterError::MathOverflow)?
        .checked_div(BPS_DENOMINATOR as u128)
        .ok_or(RouterError::MathOverflow)? as u64)
}

/// The fee is always paid in native SOL from the agent, whichever venue the
/// trade used, so the vault accumulates one asset and reconciles simply.
pub fn take_fee<'info>(
    agent: &AccountInfo<'info>,
    fee_vault: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    fee: u64,
) -> Result<()> {
    if fee == 0 {
        return Ok(());
    }
    invoke(
        &system_instruction::transfer(agent.key, fee_vault.key, fee),
        &[agent.clone(), fee_vault.clone(), system_program.clone()],
    )?;
    Ok(())
}

/// Raw `amount` from an SPL Token or Token-2022 account. Reading the two bytes
/// we need avoids pulling in anchor-spl, which would roughly double the binary
/// and therefore the deploy cost.
pub fn token_amount(account: &AccountInfo) -> Result<u64> {
    let data = account.try_borrow_data()?;
    require!(
        data.len() >= TOKEN_AMOUNT_OFFSET + 8,
        RouterError::BadTokenAccount
    );
    let mut buf = [0u8; 8];
    buf.copy_from_slice(&data[TOKEN_AMOUNT_OFFSET..TOKEN_AMOUNT_OFFSET + 8]);
    Ok(u64::from_le_bytes(buf))
}

/// Only consulted while `restrict_mints` is on. Verifies the caller handed us
/// the real allow account for this exact mint rather than any account at all:
/// right PDA, owned by us, right discriminator, and the mint it stores matches.
pub fn require_mint_allowed(allow: &AccountInfo, mint: &Pubkey) -> Result<()> {
    let (expected, _) = Pubkey::find_program_address(&[b"mint", mint.as_ref()], &crate::ID);
    require_keys_eq!(*allow.key, expected, RouterError::MintNotAllowed);
    require_keys_eq!(*allow.owner, crate::ID, RouterError::MintNotAllowed);

    let data = allow.try_borrow_data()?;
    require!(data.len() >= 40, RouterError::MintNotAllowed);
    require!(
        data[..8] == MintAllow::DISCRIMINATOR[..],
        RouterError::MintNotAllowed
    );
    require!(&data[8..40] == mint.as_ref(), RouterError::MintNotAllowed);
    Ok(())
}

/// `complete` sits after the five u64 reserve fields on pump.fun's BondingCurve.
/// Refusing a graduated curve here fails loudly instead of reverting somewhere
/// deep inside pump.fun with an error nobody can read.
pub fn require_curve_open(bonding_curve: &AccountInfo) -> Result<()> {
    let data = bonding_curve.try_borrow_data()?;
    const COMPLETE_OFFSET: usize = 8 + 8 * 5;
    require!(data.len() > COMPLETE_OFFSET, RouterError::BadTokenAccount);
    require!(data[COMPLETE_OFFSET] == 0, RouterError::CurveComplete);
    Ok(())
}
