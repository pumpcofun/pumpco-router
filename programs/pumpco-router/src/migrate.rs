//! One-shot account migration.
//!
//! `Config` and `AgentAuth` each grew a field after they had already been
//! written to mainnet, and a shorter account cannot be deserialized into a
//! longer struct. Everything that loads Config therefore stopped working, which
//! is every instruction this program has.
//!
//! Both new fields were inserted in the middle of their struct rather than
//! appended, so a migration cannot just grow the account and write the new
//! value: the trailing bytes have to move first. This reads the tail, resizes,
//! then lays the record back down in the new order.
//!
//! Config and the agent are handled by one instruction because each
//! `#[derive(Accounts)]` struct costs roughly six kilobytes of generated code,
//! and the program is already close to its on-chain allocation. Either half is
//! skipped if it has already been done, so this can be run once per agent.
//!
//! It is dead weight once run, and the next upgrade should drop it.

use anchor_lang::prelude::*;

use crate::state::*;

/// Before `total_reward_bps` was inserted ahead of `paused` and `bump`.
pub const OLD_CONFIG_LEN: usize = 8 + 32 + 32 + 32 + 2 + 8 + 8 + 1 + 1;
/// Before `fee_bps` was inserted ahead of `enabled`.
pub const OLD_AGENT_LEN: usize = 8 + 32 + 8 + 8 + 8 + 2 + 1 + 1 + 1;

/// Where each record stops being identical between the two layouts.
const CONFIG_SPLIT: usize = 8 + 32 + 32 + 32 + 2 + 8 + 8;
const AGENT_SPLIT: usize = 8 + 32 + 8 + 8 + 8 + 2;

pub fn run(
    config: &AccountInfo,
    agent: &AccountInfo,
    authority: &AccountInfo,
    program_id: &Pubkey,
    total_reward_bps: u64,
    fee_bps: u16,
) -> Result<()> {
    require!(
        total_reward_bps <= BPS_DENOMINATOR,
        RouterError::RewardSharesTooHigh
    );
    require!(fee_bps <= MAX_FEE_BPS, RouterError::FeeTooHigh);
    require_keys_eq!(*config.owner, *program_id, RouterError::Unauthorized);
    require_keys_eq!(*agent.owner, *program_id, RouterError::Unauthorized);

    let did_config = migrate_config(config, authority, total_reward_bps)?;
    let did_agent = migrate_agent(agent, fee_bps)?;

    // Both already done means the caller is repeating themselves, and silently
    // succeeding would read as though something had happened.
    require!(did_config || did_agent, RouterError::AlreadyMigrated);
    Ok(())
}

/// Returns false if this account is already at the current layout.
fn migrate_config(
    account: &AccountInfo,
    authority: &AccountInfo,
    total_reward_bps: u64,
) -> Result<bool> {
    let (paused, bump) = {
        let data = account.try_borrow_data()?;
        if data.len() != OLD_CONFIG_LEN {
            return Ok(false);
        }
        require!(
            data[..8] == Config::DISCRIMINATOR[..],
            RouterError::AlreadyMigrated
        );

        // Config cannot be deserialized right now, so the authority it names
        // has to be read raw. Its offset is the same in both layouts.
        let mut named = [0u8; 32];
        named.copy_from_slice(&data[8..40]);
        require_keys_eq!(
            Pubkey::new_from_array(named),
            *authority.key,
            RouterError::Unauthorized
        );
        (data[CONFIG_SPLIT], data[CONFIG_SPLIT + 1])
    };

    grow(account, Config::LEN)?;

    let mut data = account.try_borrow_mut_data()?;
    data[CONFIG_SPLIT..CONFIG_SPLIT + 8].copy_from_slice(&total_reward_bps.to_le_bytes());
    data[CONFIG_SPLIT + 8] = paused;
    data[CONFIG_SPLIT + 9] = bump;
    Ok(true)
}

fn migrate_agent(account: &AccountInfo, fee_bps: u16) -> Result<bool> {
    let (enabled, managed, bump) = {
        let data = account.try_borrow_data()?;
        if data.len() != OLD_AGENT_LEN {
            return Ok(false);
        }
        require!(
            data[..8] == AgentAuth::DISCRIMINATOR[..],
            RouterError::AlreadyMigrated
        );
        (
            data[AGENT_SPLIT],
            data[AGENT_SPLIT + 1],
            data[AGENT_SPLIT + 2],
        )
    };

    grow(account, AgentAuth::LEN)?;

    let mut data = account.try_borrow_mut_data()?;
    data[AGENT_SPLIT..AGENT_SPLIT + 2].copy_from_slice(&fee_bps.to_le_bytes());
    data[AGENT_SPLIT + 2] = enabled;
    data[AGENT_SPLIT + 3] = managed;
    data[AGENT_SPLIT + 4] = bump;
    Ok(true)
}

/// Resize, refusing to leave the account short of rent at its new length.
///
/// The few extra lamports are not collected here. Doing that needs a System
/// CPI, to move an amount the caller can just as easily send in a plain
/// transfer ahead of this instruction in the same transaction.
fn grow(account: &AccountInfo, len: usize) -> Result<()> {
    require!(
        account.lamports() >= Rent::get()?.minimum_balance(len),
        RouterError::NotRentExempt
    );
    account.resize(len)?;
    Ok(())
}
