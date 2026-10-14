"""Redis admission control is shared by AI replicas; it owns no business state."""
import os
from fastapi import HTTPException

_SCRIPT = """
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return count
"""

async def enforce_rate_limit(redis, tenant_id, actor_id):
    limit = int(os.getenv('AI_REQUESTS_PER_MINUTE', '120'))
    if limit < 1:
        raise HTTPException(status_code=503, detail='Admission control is unavailable')
    try:
        count = await redis.eval(_SCRIPT, 1, f'ai:admission:{tenant_id}:{actor_id}', 60)
    except Exception as error:
        raise HTTPException(status_code=503, detail='Admission control is unavailable. Retry shortly.') from error
    if int(count) > limit:
        raise HTTPException(status_code=429, detail='Request limit exceeded. Retry in one minute.', headers={'Retry-After':'60'})
