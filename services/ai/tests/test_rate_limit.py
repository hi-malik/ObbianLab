import pytest
from fastapi import HTTPException
from app.rate_limit import enforce_rate_limit

@pytest.mark.asyncio
async def test_shared_admission_counter_and_identity_key(monkeypatch):
    monkeypatch.setenv('AI_REQUESTS_PER_MINUTE','2')
    class Redis:
        count=0
        async def eval(self, script, keys, key, ttl):
            assert keys==1 and key=='ai:admission:tenant:actor' and ttl==60
            assert "EXPIRE" in script
            self.count+=1
            return self.count
    shared=Redis()
    await enforce_rate_limit(shared,'tenant','actor')
    await enforce_rate_limit(shared,'tenant','actor')
    with pytest.raises(HTTPException) as error:await enforce_rate_limit(shared,'tenant','actor')
    assert error.value.status_code==429 and error.value.headers['Retry-After']=='60'

@pytest.mark.asyncio
async def test_redis_failure_does_not_bypass_production_cost_control():
    class Redis:
        async def eval(self,*args):raise ConnectionError('down')
    with pytest.raises(HTTPException) as error:await enforce_rate_limit(Redis(),'tenant','actor')
    assert error.value.status_code==503
