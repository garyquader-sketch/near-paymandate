use near_sdk::collections::{LookupMap, Vector};
use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{Value, json};
use near_sdk::{AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError, env, ext_contract, near, require};

const RESERVE: u128 = 100_000_000_000_000_000_000_000;

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Status { Approved, Processing, Paid, Cancelled, Expired }

#[near(serializers = [borsh, json])]
pub struct Mandate {
    pub mandate_id: String,
    pub owner_id: AccountId,
    pub recipient_id: AccountId,
    pub amount_yocto: U128,
    pub invoice_hash: String,
    pub expires_at_ns: U64,
    pub status: Status,
    pub reservation_active: bool,
    pub created_at_ns: U64,
    pub execution_attempt_id: U64,
}

impl Mandate {
    fn status(&self) -> Status {
        if self.status == Status::Approved && env::block_timestamp() >= self.expires_at_ns.0 {
            return Status::Expired;
        }
        self.status
    }
}

#[ext_contract(ext_self)]
#[allow(dead_code)]
trait Settlement {
    fn settle(&mut self, mandate_id: String, attempt: U64) -> Status;
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct PayMandate {
    owner_id: AccountId,
    agent_id: AccountId,
    available: u128,
    reserved: u128,
    mandates: LookupMap<String, Mandate>,
    invoice_ids: LookupMap<String, String>,
    ids: Vector<String>,
}

#[near]
impl PayMandate {
    #[init]
    pub fn new(owner_id: AccountId, agent_id: AccountId) -> Self {
        let contract = env::current_account_id();
        require!(env::predecessor_account_id() == contract, "DEPLOYER_ONLY");
        require!(owner_id != agent_id && agent_id != contract && owner_id != contract, "SEPARATE_ACCOUNTS");
        Self {
            owner_id, agent_id, available: 0, reserved: 0,
            mandates: LookupMap::new(b"m"), invoice_ids: LookupMap::new(b"h"), ids: Vector::new(b"i"),
        }
    }

    #[payable]
    pub fn fund(&mut self) {
        self.assert_owner();
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "EMPTY_DEPOSIT");
        self.available = self.available.checked_add(amount).expect("BALANCE_OVERFLOW");
        self.assert_collateral();
        Self::event("funded", json!({"amount_yocto": U128(amount)}));
    }

    #[payable]
    pub fn approve_mandate(&mut self, mandate_id: String, recipient_id: AccountId, amount_yocto: U128,
        invoice_hash: String, expires_at_ns: U64) -> Mandate {
        self.assert_owner_action();
        require!(!mandate_id.is_empty() && mandate_id.len() <= 64
            && mandate_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'), "INVALID_ID");
        require!(invoice_hash.len() == 64 && invoice_hash.bytes().all(|b| b.is_ascii_digit()
            || (b'a'..=b'f').contains(&b)), "INVALID_HASH");
        require!(recipient_id != env::current_account_id(), "SELF_PAYMENT");
        require!(amount_yocto.0 > 0 && amount_yocto.0 <= self.available, "INSUFFICIENT_FUNDS");
        require!(expires_at_ns.0 > env::block_timestamp(), "INVALID_EXPIRY");
        require!(!self.mandates.contains_key(&mandate_id), "DUPLICATE_ID");
        require!(!self.invoice_ids.contains_key(&invoice_hash), "DUPLICATE_INVOICE");
        let mandate = Mandate {
            mandate_id: mandate_id.clone(), owner_id: self.owner_id.clone(), recipient_id, amount_yocto,
            invoice_hash: invoice_hash.clone(), expires_at_ns, status: Status::Approved, reservation_active: true,
            created_at_ns: U64(env::block_timestamp()), execution_attempt_id: U64(0),
        };
        self.available -= amount_yocto.0;
        self.reserved += amount_yocto.0;
        self.mandates.insert(&mandate_id, &mandate);
        self.invoice_ids.insert(&invoice_hash, &mandate_id);
        self.ids.push(&mandate_id);
        self.assert_collateral();
        Self::event("approved", json!({"mandate_id": mandate_id}));
        mandate
    }

    #[payable]
    pub fn cancel_mandate(&mut self, mandate_id: String) -> Status {
        self.assert_owner_action();
        let mut mandate = self.load(&mandate_id);
        require!(mandate.status == Status::Approved, "NOT_CANCELLABLE");
        mandate.status = if mandate.status() == Status::Expired { Status::Expired } else { Status::Cancelled };
        mandate.reservation_active = false;
        self.reserved -= mandate.amount_yocto.0;
        self.available += mandate.amount_yocto.0;
        self.invoice_ids.remove(&mandate.invoice_hash);
        self.mandates.insert(&mandate_id, &mandate);
        Self::event("released", json!({"mandate_id": mandate_id, "status": mandate.status}));
        mandate.status
    }

    pub fn execute_mandate(&mut self, mandate_id: String, recipient_id: AccountId, amount_yocto: U128,
        invoice_hash: String) -> Promise {
        require!(env::predecessor_account_id() == self.agent_id, "AGENT_ONLY");
        let mut mandate = self.load(&mandate_id);
        require!(mandate.status() == Status::Approved, "NOT_APPROVED");
        require!(recipient_id == mandate.recipient_id, "RECIPIENT_MISMATCH");
        require!(amount_yocto == mandate.amount_yocto, "AMOUNT_MISMATCH");
        require!(invoice_hash == mandate.invoice_hash, "INVOICE_MISMATCH");
        require!(mandate.reservation_active && self.reserved >= mandate.amount_yocto.0, "MISSING_RESERVATION");
        require!(self.liquid() >= mandate.amount_yocto.0, "INSUFFICIENT_LIQUIDITY");
        mandate.execution_attempt_id.0 = mandate.execution_attempt_id.0.checked_add(1).expect("ATTEMPT_OVERFLOW");
        mandate.status = Status::Processing;
        self.mandates.insert(&mandate_id, &mandate);
        Self::event("processing", json!({"mandate_id": mandate_id, "attempt": mandate.execution_attempt_id}));
        Promise::new(mandate.recipient_id)
            .transfer(NearToken::from_yoctonear(mandate.amount_yocto.0))
            .then(ext_self::ext(env::current_account_id()).with_static_gas(Gas::from_tgas(15))
                .settle(mandate_id, mandate.execution_attempt_id))
    }

    #[private]
    pub fn settle(&mut self, mandate_id: String, attempt: U64) -> Status {
        require!(env::predecessor_account_id() == env::current_account_id(), "PRIVATE_CALLBACK");
        let mut mandate = self.load(&mandate_id);
        require!(mandate.status == Status::Processing && mandate.execution_attempt_id == attempt, "STALE_CALLBACK");
        require!(env::promise_results_count() == 1, "MISSING_RECEIPT");
        let event = match env::promise_result_checked(0, 0) {
            Ok(_) => {
                self.reserved -= mandate.amount_yocto.0;
                mandate.status = Status::Paid;
                mandate.reservation_active = false;
                "paid"
            }
            Err(PromiseError::Failed) => {
                mandate.status = Status::Approved;
                "transfer_failed"
            }
            _ => env::panic_str("UNKNOWN_RECEIPT"),
        };
        self.mandates.insert(&mandate_id, &mandate);
        Self::event(event, json!({"mandate_id": mandate_id, "attempt": attempt}));
        mandate.status
    }

    pub fn get_mandate(&self, mandate_id: String) -> Option<Mandate> {
        let mut mandate = self.mandates.get(&mandate_id)?;
        mandate.status = mandate.status();
        Some(mandate)
    }

    pub fn list_mandates(&self, offset: U64, limit: u32) -> Vec<Mandate> {
        let end = offset.0.saturating_add(u64::from(limit.min(100))).min(self.ids.len());
        (offset.0..end).filter_map(|index| self.ids.get(index))
            .filter_map(|id| self.get_mandate(id)).collect()
    }

    pub fn get_config(&self) -> Value {
        json!({"owner_id": self.owner_id, "agent_id": self.agent_id, "available_yocto": U128(self.available),
            "reserved_yocto": U128(self.reserved), "mandate_count": U64(self.ids.len())})
    }

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner_id, "OWNER_ONLY");
    }

    fn assert_owner_action(&self) {
        self.assert_owner();
        near_sdk::assert_one_yocto();
    }

    fn load(&self, mandate_id: &String) -> Mandate {
        self.mandates.get(mandate_id).expect("MANDATE_NOT_FOUND")
    }

    fn liquid(&self) -> u128 {
        let storage = env::storage_byte_cost().as_yoctonear() * u128::from(env::storage_usage());
        env::account_balance().as_yoctonear().saturating_sub(storage + RESERVE)
    }

    fn assert_collateral(&self) {
        require!(self.liquid() >= self.available.checked_add(self.reserved).expect("BALANCE_OVERFLOW"),
            "TOP_UP_UNALLOCATED_STORAGE_BALANCE");
    }

    fn event(event: &str, data: Value) {
        env::log_str(&format!("EVENT_JSON:{}", json!({
            "standard": "paymandate", "version": "1.0.0", "event": event, "data": [data]
        })));
    }
}

#[cfg(test)]
mod tests;
