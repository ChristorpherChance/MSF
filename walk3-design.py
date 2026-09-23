# 设计八册批量生成：generate(SSE) → accept all → commit
import sys, json, time, urllib.request, uuid
sys.path.insert(0, '.')
from walk3 import req, PID

fid = '860af1bf-810a-4a08-b383-b4833fdf1fc3'
fp = 'sha256:1f01e5d9ceed647dddf060ff19469f97970a41a42bbf27966d3658064930e870'
BASE = f'http://localhost:8080/api/v1/projects/{PID}'

def sse_generate(kind, instruction):
    r = urllib.request.Request(BASE + f'/design/docs/{kind}:generate',
        data=json.dumps({'referenceFileIds': [fid], 'referenceFingerprints': {fid: fp}, 'instruction': instruction}).encode(), method='POST')
    r.add_header('Content-Type', 'application/json'); r.add_header('Idempotency-Key', str(uuid.uuid4()))
    try:
        resp = urllib.request.urlopen(r, timeout=900)
    except urllib.error.HTTPError as e:
        return None, f'HTTP {e.code}: {e.read().decode()[:200]}'
    buf = b''; done = None; deltas = 0
    while not done:
        chunk = resp.read(1)
        if not chunk: break
        buf += chunk
        while b'\n\n' in buf:
            frame, buf = buf.split(b'\n\n', 1)
            line = frame.decode('utf-8', 'replace')
            if not line.startswith('data: '): continue
            ev = json.loads(line[6:])
            if ev['type'] == 'stream.delta': deltas += 1
            elif ev['type'] in ('stream.done', 'stream.error'): done = ev
    return done, deltas

KINDS = ['hld', 'alg', 'api', 'cls', 'db', 'mod', 'nfr', 'ui']
results = {}
for kind in KINDS:
    t0 = time.time()
    done, deltas = sse_generate(kind, f'依据已定稿 PRD（v3，REQ-001~REQ-018）与参考设计说明书生成{kind}设计文档，章节承接 REQ 编号')
    if not done or done.get('type') == 'stream.error':
        results[kind] = f'GENERATE_FAIL: {done}'
        print(f'[{kind}] GENERATE_FAIL {done}', flush=True)
        continue
    c, b = req('GET', f'/design/docs/{kind}/patches')
    pend = [p for p in b.get('items', []) if p.get('status') == 'pending']
    fails = 0
    for p in pend:
        cc, bb = req('POST', f"/design/docs/{kind}/patches/{p['patchId']}:accept", {})
        if cc != 200: fails += 1
    c, b = req('GET', f'/design/docs/{kind}')
    ver = b.get('version')
    c, b = req('POST', f'/design/docs/{kind}/versions:commit', {'baseVersion': ver})
    results[kind] = f'patches={len(pend)} accept_fail={fails} commit={c} elapsed={time.time()-t0:.0f}s'
    print(f'[{kind}] {results[kind]}', flush=True)
print('SUMMARY', json.dumps(results, ensure_ascii=False), flush=True)
