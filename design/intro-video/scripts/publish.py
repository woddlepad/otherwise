# Uploads /tmp/vid/pub to the Vercel project "otherwise-demo" (production). Usage: python3 publish.py
import hashlib, json, os, urllib.request
TOKEN = os.environ['VERCEL_API_KEY']; TEAM = 'team_OENvRt6r4RiOFXM5c4GqqBR8'; DIR = '/tmp/vid/pub'
def req(method, path, body=None, headers={}):
    r = urllib.request.Request(f'https://api.vercel.com{path}{"&" if "?" in path else "?"}teamId={TEAM}', data=body, method=method,
        headers={'Authorization': f'Bearer {TOKEN}', **headers})
    try:
        with urllib.request.urlopen(r) as res: return json.loads(res.read() or b'{}')
    except urllib.error.HTTPError as e: raise SystemExit(f'{path}: {e.code} {e.read()[:400]}')
files = []
for name in sorted(os.listdir(DIR)):
    data = open(f'{DIR}/{name}', 'rb').read(); sha = hashlib.sha1(data).hexdigest()
    req('POST', '/v2/files', data, {'x-vercel-digest': sha, 'Content-Type': 'application/octet-stream'})
    files.append({'file': name, 'sha': sha, 'size': len(data)})
d = req('POST', '/v13/deployments', json.dumps({'name': 'otherwise-demo', 'target': 'production', 'files': files,
    'projectSettings': {'framework': None}}).encode(), {'Content-Type': 'application/json'})
print(d.get('id'), d.get('readyState'), d.get('alias'), d.get('url'))
