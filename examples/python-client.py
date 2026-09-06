import json
import os
import urllib.request

BASE_URL = os.getenv("GATEWAY_URL", "http://127.0.0.1:3000")
API_KEY = os.getenv("GATEWAY_API_KEY")


def request(path, method="GET", body=None):
    headers = {"content-type": "application/json"}
    if API_KEY:
        headers["authorization"] = f"Bearer {API_KEY}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE_URL + path, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req) as response:
        return json.load(response)


session = request("/v1/sessions", "POST", {"directory": os.getcwd()})["session"]
accepted = request(
    f"/v1/sessions/{session['id']}/messages",
    "POST",
    {"content": "Inspect this project and summarize it."},
)

headers = {"accept": "text/event-stream"}
if API_KEY:
    headers["authorization"] = f"Bearer {API_KEY}"
stream = urllib.request.urlopen(urllib.request.Request(BASE_URL + "/v1/events", headers=headers))
for raw_line in stream:
    line = raw_line.decode().strip()
    if not line.startswith("data: "):
        continue
    event = json.loads(line[6:])
    if event.get("runId") != accepted["runId"]:
        continue
    print(event["type"], event["data"])
    if event["type"] in {"generation.completed", "generation.failed", "generation.stopped"}:
        break
