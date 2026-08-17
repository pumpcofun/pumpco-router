//! PumpSwap venue: the token has graduated and the quote is WSOL.
//!
//! The difference that matters is the quote asset. On the curve, value moves as
//! native lamports on the agent account. Here it moves as SPL transfers on the
//! agent's WSOL account, so measuring the agent's lamport delta would read as
//! roughly zero and the fee would silently never be charged.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke,
};

use crate::guards::*;
use crate::state::*;
use crate::TradeAmm;

pub fn route<'info>(
    a: &mut TradeAmm<'info>,
    remaining: &[AccountInfo<'info>],
    ceiling: u64,
    side: Side,
    data: Vec<u8>,
) -> Result<()> {
    let fee_bps = a.config.fee_bps;
    let max_per_trade = a.config.max_lamports_per_trade;

    require!(!a.config.paused, RouterError::Paused);
    require!(a.agent_auth.enabled, RouterError::AgentDisabled);

    if side == Side::Buy {
        require!(ceiling > 0, RouterError::ZeroAmount);
        require!(ceiling <= max_per_trade, RouterError::TradeTooLarge);
        charge_daily_budget(&mut a.agent_auth, ceiling)?;
    }

    let quote = a.user_quote_token_account.to_account_info();
    let before = token_amount(&quote)?;

    invoke(
        &Instruction {
            program_id: PUMP_AMM_PROGRAM,
            accounts: metas(a, remaining, side),
            data,
        },
        &infos(a, remaining, side),
    )?;

    let after = token_amount(&quote)?;
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
        mint: a.base_mint.key(),
        is_buy: side == Side::Buy,
        on_amm: true,
        quote_moved: moved,
        fee_lamports: fee,
        timestamp: Clock::get()?.unix_timestamp,
    });
    Ok(())
}

/// PumpSwap's order, from its IDL. Buy carries the two volume accumulators that
/// sell does not; everything else is identical.
fn metas<'info>(a: &TradeAmm<'info>, remaining: &[AccountInfo<'info>], side: Side) -> Vec<AccountMeta> {
    let mut m = vec![
        AccountMeta::new(a.pool.key(), false),
        AccountMeta::new(a.agent.key(), true),
        AccountMeta::new_readonly(a.global_config.key(), false),
        AccountMeta::new_readonly(a.base_mint.key(), false),
        AccountMeta::new_readonly(a.quote_mint.key(), false),
        AccountMeta::new(a.user_base_token_account.key(), false),
        AccountMeta::new(a.user_quote_token_account.key(), false),
        AccountMeta::new(a.pool_base_token_account.key(), false),
        AccountMeta::new(a.pool_quote_token_account.key(), false),
        AccountMeta::new_readonly(a.protocol_fee_recipient.key(), false),
        AccountMeta::new(a.protocol_fee_recipient_token_account.key(), false),
        AccountMeta::new_readonly(a.base_token_program.key(), false),
        AccountMeta::new_readonly(a.quote_token_program.key(), false),
        AccountMeta::new_readonly(a.system_program.key(), false),
        AccountMeta::new_readonly(a.associated_token_program.key(), false),
        AccountMeta::new_readonly(a.event_authority.key(), false),
        AccountMeta::new_readonly(a.amm_program.key(), false),
        AccountMeta::new(a.coin_creator_vault_ata.key(), false),
        AccountMeta::new_readonly(a.coin_creator_vault_authority.key(), false),
    ];
    if side == Side::Buy {
        m.push(AccountMeta::new_readonly(a.global_volume_accumulator.key(), false));
        m.push(AccountMeta::new(a.user_volume_accumulator.key(), false));
    }
    m.push(AccountMeta::new_readonly(a.fee_config.key(), false));
    m.push(AccountMeta::new_readonly(a.fee_program.key(), false));

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
    a: &TradeAmm<'info>,
    remaining: &[AccountInfo<'info>],
    side: Side,
) -> Vec<AccountInfo<'info>> {
    let mut v = vec![
        a.pool.to_account_info(),
        a.agent.to_account_info(),
        a.global_config.to_account_info(),
        a.base_mint.to_account_info(),
        a.quote_mint.to_account_info(),
        a.user_base_token_account.to_account_info(),
        a.user_quote_token_account.to_account_info(),
        a.pool_base_token_account.to_account_info(),
        a.pool_quote_token_account.to_account_info(),
        a.protocol_fee_recipient.to_account_info(),
        a.protocol_fee_recipient_token_account.to_account_info(),
        a.base_token_program.to_account_info(),
        a.quote_token_program.to_account_info(),
        a.system_program.to_account_info(),
        a.associated_token_program.to_account_info(),
        a.event_authority.to_account_info(),
        a.amm_program.to_account_info(),
        a.coin_creator_vault_ata.to_account_info(),
        a.coin_creator_vault_authority.to_account_info(),
    ];
    if side == Side::Buy {
        v.push(a.global_volume_accumulator.to_account_info());
        v.push(a.user_volume_accumulator.to_account_info());
    }
    v.push(a.fee_config.to_account_info());
    v.push(a.fee_program.to_account_info());
    v.extend(remaining.iter().cloned());
    v
}
