//! Bonding curve venue: the token has not graduated and the quote is native SOL.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke,
};

use crate::guards::*;
use crate::state::*;
use crate::TradeCurve;

pub fn route<'info>(
    a: &mut TradeCurve<'info>,
    remaining: &[AccountInfo<'info>],
    ceiling: u64,
    side: Side,
    data: Vec<u8>,
) -> Result<()> {
    let fee_bps = a.config.fee_bps;
    let max_per_trade = a.config.max_lamports_per_trade;

    require!(!a.config.paused, RouterError::Paused);
    require!(a.agent_auth.enabled, RouterError::AgentDisabled);
    require_curve_open(&a.bonding_curve.to_account_info())?;
    if a.config.restrict_mints {
        require_mint_allowed(&a.mint_allow.to_account_info(), &a.mint.key())?;
    }

    if side == Side::Buy {
        require!(ceiling > 0, RouterError::ZeroAmount);
        require!(ceiling <= max_per_trade, RouterError::TradeTooLarge);
        charge_daily_budget(&mut a.agent_auth, ceiling)?;
    }

    let before = a.agent.lamports();

    invoke(
        &Instruction {
            program_id: PUMP_PROGRAM,
            accounts: metas(a, remaining, side),
            data,
        },
        &infos(a, remaining, side),
    )?;

    let after = a.agent.lamports();
    let moved = match side {
        Side::Buy => before.saturating_sub(after),
        Side::Sell => after.saturating_sub(before),
    };

    let fee = fee_for(moved, fee_bps)?;
    take_fee(
        &a.agent.to_account_info(),
        &a.fee_vault.to_account_info(),
        &a.system_program.to_account_info(),
        fee,
    )?;

    emit!(TradeRouted {
        agent: a.agent.key(),
        mint: a.mint.key(),
        is_buy: side == Side::Buy,
        on_amm: false,
        quote_moved: moved,
        fee_lamports: fee,
        timestamp: Clock::get()?.unix_timestamp,
    });
    Ok(())
}

/// pump.fun's order, from its IDL. Buy carries the two volume accumulators that
/// sell does not, and the two swap `creator_vault` and `token_program`.
fn metas<'info>(a: &TradeCurve<'info>, remaining: &[AccountInfo<'info>], side: Side) -> Vec<AccountMeta> {
    let mut m = vec![
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
            m.push(AccountMeta::new_readonly(a.token_program.key(), false));
            m.push(AccountMeta::new(a.creator_vault.key(), false));
        }
        Side::Sell => {
            m.push(AccountMeta::new(a.creator_vault.key(), false));
            m.push(AccountMeta::new_readonly(a.token_program.key(), false));
        }
    }
    m.push(AccountMeta::new_readonly(a.event_authority.key(), false));
    m.push(AccountMeta::new_readonly(a.pump_program.key(), false));
    if side == Side::Buy {
        m.push(AccountMeta::new_readonly(a.global_volume_accumulator.key(), false));
        m.push(AccountMeta::new(a.user_volume_accumulator.key(), false));
    }
    m.push(AccountMeta::new_readonly(a.fee_config.key(), false));
    m.push(AccountMeta::new_readonly(a.fee_program.key(), false));

    // Live buys carry trailing accounts beyond the 16 in the IDL.
    for acc in remaining.iter() {
        m.push(if acc.is_writable {
            AccountMeta::new(*acc.key, acc.is_signer)
        } else {
            AccountMeta::new_readonly(*acc.key, acc.is_signer)
        });
    }
    m
}

fn infos<'info>(
    a: &TradeCurve<'info>,
    remaining: &[AccountInfo<'info>],
    side: Side,
) -> Vec<AccountInfo<'info>> {
    let mut v = vec![
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
            v.push(a.token_program.to_account_info());
            v.push(a.creator_vault.to_account_info());
        }
        Side::Sell => {
            v.push(a.creator_vault.to_account_info());
            v.push(a.token_program.to_account_info());
        }
    }
    v.push(a.event_authority.to_account_info());
    v.push(a.pump_program.to_account_info());
    if side == Side::Buy {
        v.push(a.global_volume_accumulator.to_account_info());
        v.push(a.user_volume_accumulator.to_account_info());
    }
    v.push(a.fee_config.to_account_info());
    v.push(a.fee_program.to_account_info());
    v.extend(remaining.iter().cloned());
    v
}
