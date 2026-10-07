# Monitoring host only. Stop its own exporter, observe real firing + resolved delivery.
import datetime, json, pathlib, socket, subprocess, time, urllib.request
assert socket.gethostname() == 'VM-20-216-ubuntu'
base = pathlib.Path('/opt/prsi-monitoring')
rules = base / 'prometheus/alerts.yml'
original = rules.read_bytes()
token = pathlib.Path('/etc/prsi-monitoring/secrets/ntfy-token').read_text().strip()
started = int(time.time())
seen = set()
def docker(*args):
    subprocess.run(['docker', *args], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
def messages():
    req = urllib.request.Request('http://127.0.0.1:8085/prsi-alerts/json?poll=1&since='+str(started), headers={'Authorization':'Bearer '+token})
    with urllib.request.urlopen(req, timeout=10) as response:
        for line in response.read().decode().splitlines():
            msg = json.loads(line).get('message','')
            for state in ['FIRING','RESOLVED']:
                if state+': MonitoringTest' in msg: seen.add(state)
def wait_for(state):
    deadline=time.time()+240
    while time.time()<deadline:
        messages()
        if state in seen:
            print(state+' notification received in ntfy',flush=True)
            return
        time.sleep(5)
    raise RuntimeError('Expected monitoring test notification missing')
try:
    rules.write_bytes(original + b"\n  - name: monitoring-rehearsal\n    rules:\n      - alert: MonitoringTest\n        expr: up{job=\"node\",instance=\"127.0.0.1:9100\"} == 0\n        for: 15s\n        labels: {severity: warning}\n")
    docker('exec','prsi-monitoring-prometheus-1','promtool','check','config','/etc/prometheus/prometheus.yml')
    docker('kill','--signal=HUP','prsi-monitoring-prometheus-1')
    docker('stop','prsi-monitoring-node-1')
    print('Monitoring host exporter stopped; production untouched',flush=True)
    wait_for('FIRING')
    docker('start','prsi-monitoring-node-1')
    print('Monitoring host exporter restarted',flush=True)
    wait_for('RESOLVED')
    result={'checked_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'target':'monitoring node exporter only','firing_received':True,'resolved_received':True}
    pathlib.Path('/var/backups/prsi-monitoring/alert-rehearsal.json').write_text(json.dumps(result,indent=2))
    print(json.dumps(result),flush=True)
finally:
    docker('start','prsi-monitoring-node-1')
    rules.write_bytes(original)
    docker('kill','--signal=HUP','prsi-monitoring-prometheus-1')
