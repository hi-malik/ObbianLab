BEGIN;

CREATE OR REPLACE FUNCTION reject_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger rows are immutable';
END;
$$;

CREATE TRIGGER ledger_entries_no_update
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
CREATE TRIGGER ledger_transactions_no_update
  BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

-- The API posts through this function so balanced debits and credits are
-- validated while all entries are still inside one transaction.
CREATE OR REPLACE FUNCTION assert_ledger_transaction_balanced(p_transaction_id uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_debits bigint;
  v_credits bigint;
  v_currencies integer;
BEGIN
  SELECT
    COALESCE(sum(amount_minor) FILTER (WHERE direction = 'debit'), 0),
    COALESCE(sum(amount_minor) FILTER (WHERE direction = 'credit'), 0),
    count(DISTINCT currency)
  INTO v_debits, v_credits, v_currencies
  FROM ledger_entries WHERE transaction_id = p_transaction_id;

  IF v_debits = 0 OR v_debits <> v_credits OR v_currencies <> 1 THEN
    RAISE EXCEPTION 'unbalanced ledger transaction %: debits %, credits %, currencies %',
      p_transaction_id, v_debits, v_credits, v_currencies;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_ledger_transaction_balanced()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM assert_ledger_transaction_balanced(NEW.transaction_id);
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER ledger_entries_balance_at_commit
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_ledger_transaction_balanced();

COMMIT;
