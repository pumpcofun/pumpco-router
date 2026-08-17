//! Creator rewards.
//!
//! pump.fun takes `creator` as a plain argument at token creation and lets
//! anyone call `collect_creator_fee` without a signature. So the token launches
//! through pump.fun exactly as normal, with `creator` set to the PDA below, and
//! its creator revenue lands somewhere only this program can move it from.
//!
//! Distribution is permissionless too. Anyone can trigger a payout; nobody can
//! change where it goes.

use anchor_lang::prelude::*;

use crate::state::*;


#[account]
pub struct CreatorVault {
    pub bump: u8,
}

impl CreatorVault {
    pub const LEN: usize = 8 + 1;
}

pub fn distribute<'a, 'info: 'a>(
    program_id: &Pubkey,
    vault: AccountInfo<'info>,
    treasury: AccountInfo<'info>,
    payees: &'a [AccountInfo<'info>],
) -> Result<()> {

    // Never spend the account out of existence.
    let reserve = Rent::get()?.minimum_balance(vault.data_len());
    let available = vault.lamports().saturating_sub(reserve);
    require!(available > 0, RouterError::NothingToDistribute);

    require!(payees.len() % 2 == 0, RouterError::MalformedPayees);

    let mut paid: u64 = 0;
    let mut bps_total: u64 = 0;

    for pair in payees.chunks(2) {
        let (auth_info, wallet_info) = (&pair[0], &pair[1]);

        // The caller chose these accounts, so prove the pairing rather than
        // trusting it: this authority must be the one derived from this wallet.
        let (expected, _) = Pubkey::find_program_address(
            &[b"agent", wallet_info.key.as_ref()],
            program_id,
        );
        require_keys_eq!(*auth_info.key, expected, RouterError::MalformedPayees);

        let (wallet, reward_bps) = read_agent(auth_info, program_id)?;
        require_keys_eq!(wallet, *wallet_info.key, RouterError::MalformedPayees);
        if reward_bps == 0 {
            continue;
        }

        bps_total = bps_total
            .checked_add(reward_bps as u64)
            .ok_or(RouterError::MathOverflow)?;
        require!(
            bps_total <= BPS_DENOMINATOR,
            RouterError::RewardSharesTooHigh
        );

        let cut = (available as u128)
            .checked_mul(reward_bps as u128)
            .ok_or(RouterError::MathOverflow)?
            .checked_div(BPS_DENOMINATOR as u128)
            .ok_or(RouterError::MathOverflow)? as u64;
        if cut == 0 {
            continue;
        }

        move_lamports(&vault, wallet_info, cut)?;
        paid = paid.checked_add(cut).ok_or(RouterError::MathOverflow)?;
    }

    // Whatever the agents were not entitled to, including rounding dust.
    let remainder = available.saturating_sub(paid);
    if remainder > 0 {
        move_lamports(&vault, &treasury, remainder)?;
    }

    emit!(RewardsDistributed {
        total: available,
        to_agents: paid,
        to_treasury: remainder,
        timestamp: Clock::get()?.unix_timestamp,
    });
    Ok(())
}

/// Read `wallet` and `reward_bps` straight out of the account. Going through
/// `Account::try_from` here drags `'info` into the loop for no benefit, and the
/// two fields we need sit at fixed offsets.
fn read_agent(info: &AccountInfo, program_id: &Pubkey) -> Result<(Pubkey, u16)> {
    require_keys_eq!(*info.owner, *program_id, RouterError::MalformedPayees);
    let data = info.try_borrow_data()?;
    require!(data.len() >= 66, RouterError::MalformedPayees);
    require!(
        data[..8] == AgentAuth::DISCRIMINATOR[..],
        RouterError::MalformedPayees
    );

    let mut wallet = [0u8; 32];
    wallet.copy_from_slice(&data[8..40]);
    let mut bps = [0u8; 2];
    bps.copy_from_slice(&data[64..66]);
    Ok((Pubkey::new_from_array(wallet), u16::from_le_bytes(bps)))
}

/// The vault is owned by this program, so lamports move by direct adjustment.
/// A System CPI would need the PDA to sign and would cost more for no gain.
fn move_lamports(from: &AccountInfo, to: &AccountInfo, amount: u64) -> Result<()> {
    **from.try_borrow_mut_lamports()? = from
        .lamports()
        .checked_sub(amount)
        .ok_or(RouterError::MathOverflow)?;
    **to.try_borrow_mut_lamports()? = to
        .lamports()
        .checked_add(amount)
        .ok_or(RouterError::MathOverflow)?;
    Ok(())
}
