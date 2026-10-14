.PHONY: up down test typecheck build smoke verify logs

up:
	docker compose up --build -d

down:
	docker compose down

test:
	npm test
	docker build -t obbian-ai-test services/ai
	docker run --rm -v "$(PWD)/services/ai/tests:/app/tests:ro" -v "$(PWD)/services/ai/pytest.ini:/app/pytest.ini:ro" -e PYTHONPATH=/app obbian-ai-test pytest -q -p no:cacheprovider /app/tests
	docker build --target build -t obbian-allocation-test services/allocation

typecheck:
	npm run typecheck

build:
	npm run build

smoke:
	python3 scripts/smoke.py

verify: typecheck build test
	docker compose config -q
	python3 scripts/smoke.py
	python3 scripts/concurrency_check.py
	python3 scripts/pipeline_replay_check.py
	python3 scripts/security_check.py
	python3 scripts/web_auth_check.py
	python3 scripts/migration_check.py
	python3 scripts/database_tests.py
	python3 scripts/deploy_check.py
	python3 scripts/booking_payment_integrity_check.py
	docker compose exec -T api node < scripts/stripe_transfer_recovery_check.cjs

logs:
	docker compose logs -f --tail=100
