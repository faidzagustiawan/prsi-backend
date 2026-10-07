import json, pathlib, sys, urllib.request, urllib.error
try:
    port=int(sys.argv[1])
    if port not in (3100,3199): raise ValueError('unexpected port')
    token=pathlib.Path(sys.argv[2]).read_text().strip()
    def request(path,auth=False):
        req=urllib.request.Request(f'http://127.0.0.1:{port}'+path,headers={'Authorization':'Bearer '+token} if auth else {})
        try:
            with urllib.request.urlopen(req,timeout=20) as response: return response.status,response.read()
        except urllib.error.HTTPError as error: return error.code,b''
    assert request('/health')[0]==200
    assert request('/internal/metrics')[0]==401
    status,body=request('/internal/metrics',True)
    assert status==200 and b'monitor_collection_success' in body
    status,body=request('/internal/checksum/companies',True)
    data=json.loads(body)
    assert status==200 and isinstance(data['count'],int) and len(data['content_hash'])==32
    status,body=request('/openapi.json')
    assert status==200 and all(not path.startswith('/internal') for path in json.loads(body)['paths'])
    print('Application health, private authentication, checksum, and OpenAPI smoke passed')
except Exception:
    print('Application smoke failed; details withheld',file=sys.stderr)
    sys.exit(1)
