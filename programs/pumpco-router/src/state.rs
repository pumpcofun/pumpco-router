use anchor_lang::prelude::*;

/// pump.fun bonding curve, mainnet. Hardcoded: the CPI target is the one thing
/// a caller must never be able to choose.
pub const PUMP_PROGRAM: Pubkey = pubkey!("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
/// PumpSwap, where a mint trades once it graduates off the curve.
pub const PUMP_AMM_PROGRAM: Pubkey = pubkey!("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");

/// Anchor derives these from the instruction name, so both programs share them.
pub const BUY_DISCRIMINATOR: [u8; 8] = [102, 6, 61, 18, 1, 218, 235, 234];
pub const SELL_DISCRIMINATOR: [u8; 8] = [51, 230, 133, 164, 1, 127, 131, 173];

/// Ceiling on the router fee. A compromised authority still cannot confiscate
/// a trade.
pub const MAX_FEE_BPS: u16 = 300;
pub const BPS_DENOMINATOR: u64 = 10_000;
pub const SECONDS_PER_DAY: i64 = 86_400;

/// Offset of `amount` in both SPL Token and Token-2022 account data.
pub const TOKEN_AMOUNT_OFFSET: usize = 64;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Venue {
    Curve,
    Amm,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Side {
    Buy,
    Sell,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ConfigArgs {
    pub fee_bps: u16,
    pub max_lamports_per_trade: u64,
    /// Ceiling applied to anyone who registers themselves.
    pub default_daily_limit: u64,
}

impl ConfigArgs {
    pub fn validate(&self) -> Result<()> {
        require!(self.fee_bps <= MAX_FEE_BPS, RouterError::FeeTooHigh);
        require!(self.max_lamports_per_trade > 0, RouterError::ZeroAmount);
        Ok(())
    }
}

#[account]
pub struct Config {
    pub authority: Pubkey,
    /// Receives whatever share of creator rewards is not assigned to agents.
    pub treasury: Pubkey,
    pub fee_vault: Pubkey,
    pub fee_bps: u16,
    pub max_lamports_per_trade: u64,
    pub default_daily_limit: u64,
    pub paused: bool,
    pub bump: u8,
}

impl Config {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 2 + 8 + 8 + 1 + 1;
}

#[account]
pub struct AgentAuth {
    pub wallet: Pubkey,
    pub daily_limit: u64,
    pub spent_today: u64,
    pub day: i64,
    /// Share of swept creator rewards, in basis points.
    pub reward_bps: u16,
    pub enabled: bool,
    /// True for the company's own machines: they cannot raise their own limits.
    /// False for wallets that registered themselves, who are spending their own
    /// money and may set whatever ceiling they like.
    pub authority_managed: bool,
    pub bump: u8,
}

impl AgentAuth {
    pub const LEN: usize = 8 + 32 + 8 + 8 + 8 + 2 + 1 + 1 + 1;
}

#[event]
pub struct TradeRouted {
    pub agent: Pubkey,
    pub mint: Pubkey,
    pub is_buy: bool,
    pub on_amm: bool,
    pub quote_moved: u64,
    pub fee_lamports: u64,
    pub timestamp: i64,
}

#[event]
pub struct RewardsDistributed {
    pub total: u64,
    pub to_agents: u64,
    pub to_treasury: u64,
    pub timestamp: i64,
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
    #[msg("treasury does not match config")]
    WrongTreasury,
    #[msg("CPI target is not a pump.fun program")]
    WrongProgram,
    #[msg("signer is not the configured authority")]
    Unauthorized,
    #[msg("this agent's limits are managed by the authority")]
    AuthorityManaged,
    #[msg("token has graduated; route through the AMM instead")]
    CurveComplete,
    #[msg("reward shares exceed 100 percent")]
    RewardSharesTooHigh,
    #[msg("distribute expects pairs of agent authority and wallet")]
    MalformedPayees,
    #[msg("nothing available to distribute")]
    NothingToDistribute,
    #[msg("token account data is malformed")]
    BadTokenAccount,
    #[msg("arithmetic overflow")]
    MathOverflow,
}
