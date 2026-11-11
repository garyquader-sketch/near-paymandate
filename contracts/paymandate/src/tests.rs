use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{PromiseResult, testing_env};

const TOTAL: u128 = 10 * 10u128.pow(24);
const AMOUNT: u128 = 10u128.pow(23);

fn id(name: &str) -> AccountId { format!("{name}.testnet").parse().unwrap() }
fn hash() -> String { "a".repeat(64) }

fn context(name: &str, deposit: u128, now: u64) -> VMContextBuilder {
    let mut builder = VMContextBuilder::new();
    builder.current_account_id(id("contract")).signer_account_id(id(name))
        .predecessor_account_id(id(name)).attached_deposit(NearToken::from_yoctonear(deposit))
        .account_balance(NearToken::from_yoctonear(TOTAL)).block_timestamp(now);
    builder
}

fn set(name: &str, deposit: u128, now: u64) { testing_env!(context(name, deposit, now).build()); }

fn setup() -> PayMandate {
    set("contract", 0, 10);
    let mut contract = PayMandate::new(id("owner"), id("agent"));
    set("owner", 2 * AMOUNT, 10);
    contract.fund();
    contract
}

fn approve(contract: &mut PayMandate, key: &str, amount: u128, invoice: String) -> Mandate {
    contract.approve_mandate(key.into(), id("vendor"), U128(amount), invoice, U64(100))
}

fn approved() -> PayMandate {
    let mut contract = setup();
    set("owner", 1, 10);
    assert_eq!(approve(&mut contract, "first", AMOUNT, hash()).status, Status::Approved);
    assert_eq!((contract.available, contract.reserved), (AMOUNT, AMOUNT));
    contract
}

fn execute(contract: &mut PayMandate) {
    let _ = contract.execute_mandate("first".into(), id("vendor"), U128(AMOUNT), hash());
}

fn result(value: PromiseResult) {
    testing_env!(context("contract", 0, 15).build(), near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(), Default::default(), vec![value]);
}

#[test]
fn successful_transfer_and_callback() {
    let mut contract = approved();
    set("agent", 0, 12);
    execute(&mut contract);
    assert_eq!(contract.load(&"first".into()).status, Status::Processing);
    let processing_log = near_sdk::test_utils::get_logs().pop().unwrap();
    let processing: Value = near_sdk::serde_json::from_str(processing_log.strip_prefix("EVENT_JSON:").unwrap()).unwrap();
    assert_eq!(processing["event"], "processing");
    assert_eq!(processing["data"][0]["attempt"], "1");
    result(PromiseResult::Successful(vec![]));
    assert_eq!(contract.settle("first".into(), U64(1)), Status::Paid);
    assert_eq!((contract.available, contract.reserved), (AMOUNT, 0));
    let paid_log = near_sdk::test_utils::get_logs().pop().unwrap();
    let paid: Value = near_sdk::serde_json::from_str(paid_log.strip_prefix("EVENT_JSON:").unwrap()).unwrap();
    assert_eq!(paid["event"], "paid");
    assert_eq!(paid["data"][0], processing["data"][0]);
}

#[test]
fn failed_transfer_is_retryable() {
    let mut contract = approved();
    set("agent", 0, 12);
    execute(&mut contract);
    result(PromiseResult::Failed);
    assert_eq!(contract.settle("first".into(), U64(1)), Status::Approved);
    assert_eq!(contract.reserved, AMOUNT);
    set("agent", 0, 16);
    execute(&mut contract);
    assert_eq!(contract.load(&"first".into()).execution_attempt_id, U64(2));
}

#[test]
fn cancellation_releases_balance_and_document() {
    let mut contract = approved();
    set("owner", 1, 15);
    assert_eq!(contract.cancel_mandate("first".into()), Status::Cancelled);
    assert_eq!((contract.available, contract.reserved), (2 * AMOUNT, 0));
    approve(&mut contract, "replacement", AMOUNT, hash());
}

#[test]
fn expired_release_is_terminal() {
    let mut contract = approved();
    set("owner", 1, 100);
    assert_eq!(contract.get_mandate("first".into()).unwrap().status, Status::Expired);
    assert_eq!(contract.cancel_mandate("first".into()), Status::Expired);
    assert_eq!(contract.reserved, 0);
}

macro_rules! reject {
    ($name:ident, $error:literal, $contract:ident, $setup:expr, $body:block) => {
        #[test]
        #[should_panic(expected = $error)]
        fn $name() {
            let mut $contract = $setup;
            $body
        }
    };
}

reject!(outsider_cannot_approve, "OWNER_ONLY", c, setup(), {
    set("outsider", 1, 10); approve(&mut c, "x", AMOUNT, hash());
});
reject!(agent_cannot_approve, "OWNER_ONLY", c, setup(), {
    set("agent", 1, 10); approve(&mut c, "x", AMOUNT, hash());
});
reject!(outsider_cannot_execute, "AGENT_ONLY", c, approved(), {
    set("outsider", 0, 12); execute(&mut c);
});
reject!(recipient_mismatch, "RECIPIENT_MISMATCH", c, approved(), {
    set("agent", 0, 12); let _ = c.execute_mandate("first".into(), id("other"), U128(AMOUNT), hash());
});
reject!(amount_mismatch, "AMOUNT_MISMATCH", c, approved(), {
    set("agent", 0, 12); let _ = c.execute_mandate("first".into(), id("vendor"), U128(1), hash());
});
reject!(document_mismatch, "INVOICE_MISMATCH", c, approved(), {
    set("agent", 0, 12); let _ = c.execute_mandate("first".into(), id("vendor"), U128(AMOUNT), "b".repeat(64));
});
reject!(expired_execution, "NOT_APPROVED", c, approved(), {
    set("agent", 0, 100); execute(&mut c);
});
reject!(cancelled_execution, "NOT_APPROVED", c, approved(), {
    c.cancel_mandate("first".into()); set("agent", 0, 12); execute(&mut c);
});
reject!(processing_duplicate, "NOT_APPROVED", c, approved(), {
    set("agent", 0, 12); execute(&mut c); execute(&mut c);
});
reject!(paid_duplicate, "NOT_APPROVED", c, approved(), {
    set("agent", 0, 12); execute(&mut c); result(PromiseResult::Successful(vec![]));
    c.settle("first".into(), U64(1)); set("agent", 0, 16); execute(&mut c);
});
reject!(excess_reservation, "INSUFFICIENT_FUNDS", c, approved(), {
    approve(&mut c, "x", AMOUNT + 1, "b".repeat(64));
});
reject!(duplicate_id, "DUPLICATE_ID", c, approved(), {
    approve(&mut c, "first", AMOUNT, "b".repeat(64));
});
reject!(duplicate_invoice, "DUPLICATE_INVOICE", c, approved(), {
    approve(&mut c, "second", AMOUNT, hash());
});
reject!(external_callback, "PRIVATE_CALLBACK", c, approved(), {
    set("agent", 0, 12); execute(&mut c); c.settle("first".into(), U64(1));
});
reject!(missing_callback_receipt, "MISSING_RECEIPT", c, approved(), {
    set("agent", 0, 12); execute(&mut c); set("contract", 0, 15); c.settle("first".into(), U64(1));
});
reject!(callback_replay, "STALE_CALLBACK", c, approved(), {
    set("agent", 0, 12); execute(&mut c); result(PromiseResult::Successful(vec![]));
    c.settle("first".into(), U64(1)); c.settle("first".into(), U64(1));
});

#[test]
fn reservations_conserve_funds_across_64_mixed_lifecycles() {
    let mut contract = setup();
    let initial = 2 * AMOUNT;
    let mut paid = 0;
    for index in 0..64u128 {
        let mandate_id = format!("payment-{index}");
        let digest = format!("{index:064x}");
        let amount = (index + 1) * AMOUNT / 4096;
        set("owner", 1, 10);
        approve(&mut contract, &mandate_id, amount, digest.clone());
        assert_eq!(contract.available + contract.reserved + paid, initial);
        assert_eq!(contract.reserved, amount);
        if index % 3 == 0 {
            assert_eq!(contract.cancel_mandate(mandate_id), Status::Cancelled);
        } else {
            set("agent", 0, 12);
            let _ = contract.execute_mandate(mandate_id.clone(), id("vendor"), U128(amount), digest.clone());
            if index % 3 == 1 {
                result(PromiseResult::Failed);
                assert_eq!(contract.settle(mandate_id.clone(), U64(1)), Status::Approved);
                assert_eq!(contract.reserved, amount);
                set("agent", 0, 16);
                let _ = contract.execute_mandate(mandate_id.clone(), id("vendor"), U128(amount), digest);
            }
            let attempt = if index % 3 == 1 { 2 } else { 1 };
            result(PromiseResult::Successful(vec![]));
            assert_eq!(contract.settle(mandate_id, U64(attempt)), Status::Paid);
            paid += amount;
        }
        assert_eq!(contract.reserved, 0);
        assert_eq!(contract.available + paid, initial);
    }
}