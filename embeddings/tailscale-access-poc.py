#!/usr/bin/env python3
"""
Access private resources via Tailscale using OAuth credentials.

This demonstrates:
1. Using Tailscale OAuth client credentials
2. Exchanging them for short-lived API token
3. Starting tailscaled to access private resources via Tailscale IP

Prerequisites:
1. Create OAuth client in Tailscale admin console
2. Set up tailnet DNS name (e.g., "mytailnet.ts.net")
3. Ensure tailscale is installed on this machine
"""

import os
import json
import subprocess
import time
import requests
import sys
from dotenv import load_dotenv

load_dotenv()


def exchange_oauth_for_token(client_id: str, client_secret: str, tailnet: str) -> str:
    """
    Exchange OAuth client credentials for Tailscale API token.
    Uses OAuth 2.0 client credentials flow (form-encoded).
    """
    url = "https://api.tailscale.com/api/v2/oauth/token"
    data = {
        "client_id": client_id,
        "client_secret": client_secret,
        "tailnet": tailnet,
    }
    resp = requests.post(url, data=data, timeout=30)
    resp.raise_for_status()
    data = resp.json()
    return data["access_token"]


def ensure_tailscale_running(ts_token: str, tailnet_name: str):
    """
    Ensure tailscaled is running and connected to tailnet.
    """
    result = subprocess.run(
        ["systemctl", "is-active", "tailscaled"], capture_output=True, text=True
    )

    if result.returncode == 0 and result.stdout.strip() == "active":
        print("tailscaled already running")
        return _wait_for_tailscale_connection(ts_token)

    print("Starting tailscaled...")
    os.makedirs("/var/run/tailscale", exist_ok=True)
    os.makedirs("/var/lib/tailscale", exist_ok=True)

    with open("/var/lib/tailscale/tailscaled.state", "w") as f:
        f.write(ts_token)

    env = os.environ.copy()
    env["TAILSCALE_STATE"] = "file"
    env["TAILSCALE_CONFIG"] = "/var/lib/tailscale"

    subprocess.Popen(
        ["/usr/sbin/tailscaled", "--tun=userspace-networking"],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    return _wait_for_tailscale_connection(ts_token)


def _wait_for_tailscale_connection(ts_token: str, timeout: int = 60) -> bool:
    """
    Wait for tailscaled to connect to the tailnet.
    """
    print("Waiting for tailscaled to connect...")
    start = time.time()
    while time.time() - start < timeout:
        try:
            resp = requests.get(
                "http://localhost:41112/localapi/v0/status",
                headers={"Authorization": f"Bearer {ts_token}"},
                timeout=5,
            )
            if resp.status_code == 200:
                data = resp.json()
                if data.get("BackendState") == "Running":
                    print(
                        f"Connected! Tailscale IP: {data.get('Self', {}).get('TailscaleIPs', [])}"
                    )
                    return True
        except requests.exceptions.ConnectionError:
            pass
        except requests.exceptions.Timeout:
            pass
        time.sleep(1)

    raise RuntimeError("tailscaled failed to connect within timeout")


def get_tailnet_resources() -> dict:
    """
    Get Tailscale hostnames for resources in the tailnet.
    Configure these as MagicDNS entries or in /etc/hosts.
    """
    return {
        "database": os.getenv("TAILSCALE_DB_HOST", "database.tailnet.ts.net"),
        "postgres": os.getenv("TAILSCALE_POSTGRES_HOST", "postgres.tailnet.ts.net"),
        "r2_gateway": os.getenv("TAILSCALE_R2_HOST", "r2.tailnet.ts.net"),
        "minio": os.getenv("TAILSCALE_MINIO_HOST", "minio.tailnet.ts.net"),
    }


def test_connection(host: str, port: int, timeout: float = 10.0):
    """
    Test TCP connection to a host:port via Tailscale.
    """
    import socket

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(timeout)
    try:
        sock.connect((host, port))
        print(f"  ✓ Connected to {host}:{port}")
        return True
    except socket.error as e:
        print(f"  ✗ Cannot connect to {host}:{port} - {e}")
        return False
    finally:
        sock.close()


def query_database(
    host: str, port: int, dbname: str, user: str, password: str, query: str = "SELECT 1"
):
    """
    Query PostgreSQL database via Tailscale.
    """
    try:
        import psycopg2

        conn = psycopg2.connect(
            host=host,
            port=port,
            dbname=dbname,
            user=user,
            password=password,
            connect_timeout=10,
        )
        cur = conn.cursor()
        cur.execute(query)
        result = cur.fetchone()
        print(f"  ✓ Database query result: {result}")
        cur.close()
        conn.close()
        return True
    except ImportError:
        print("  ! psycopg2 not installed - skipping database test")
        return False
    except Exception as e:
        print(f"  ✗ Database query failed: {e}")
        return False


def main():
    print("=" * 60)
    print("Tailscale Private Resource Access (OAuth)")
    print("=" * 60)

    client_id = os.getenv("TAILSCALE_CLIENT_ID")
    client_secret = os.getenv("TAILSCALE_CLIENT_SECRET")
    tailnet_name = os.getenv("TAILSCALE_TAILNET", "mytailnet")

    if not client_id or not client_secret:
        print("\n✗ Missing OAuth credentials.")
        print("\nSet these environment variables:")
        print("  export TAILSCALE_CLIENT_ID='your-client-id'")
        print("  export TAILSCALE_CLIENT_SECRET='your-client-secret'")
        print("  export TAILSCALE_TAILNET='your-tailnet-name'")
        print("\nTo create OAuth credentials:")
        print("  1. Go to https://login.tailscale.com/admin/settings/oauth")
        print("  2. Create OAuth client with 'Tailnet' scope")
        print("  3. Copy client ID and secret")
        sys.exit(1)

    print(f"\nTailnet: {tailnet_name}")

    print("\n[1/2] Exchanging OAuth credentials for Tailscale API token...")
    try:
        ts_token = exchange_oauth_for_token(client_id, client_secret, tailnet_name)
        print(f"  ✓ API token obtained (length: {len(ts_token)})")
    except requests.exceptions.HTTPError as e:
        print(f"  ✗ Token exchange failed: {e.response.text}")
        print("\nCheck your OAuth credentials and tailnet name.")
        sys.exit(1)

    print("\n[2/2] Ensuring tailscaled is running...")
    try:
        ensure_tailscale_running(ts_token, tailnet_name)
        print("  ✓ Connected to tailnet")
    except RuntimeError as e:
        print(f"  ✗ {e}")
        sys.exit(1)

    resources = get_tailnet_resources()
    print(f"\n{'-' * 60}")
    print("Testing private resource access via Tailscale:")
    print(f"{'-' * 60}\n")

    results = {}

    for name, host in resources.items():
        if host == f"{name}.tailnet.ts.net":
            print(f"[{name}] {host} (default - configure to enable)")
            continue

        print(f"[{name}] {host}")

        if name in ["database", "postgres"]:
            db_port = int(os.getenv("TAILSCALE_DB_PORT", "5432"))
            dbname = os.getenv("TAILSCALE_DB_NAME", "postgres")
            db_user = os.getenv("TAILSCALE_DB_USER", "postgres")
            db_password = os.getenv("TAILSCALE_DB_PASSWORD", "")
            if db_password:
                results[name] = query_database(
                    host, db_port, dbname, db_user, db_password
                )
            else:
                results[name] = test_connection(host, db_port)
        elif name in ["r2_gateway", "minio"]:
            results[name] = test_connection(host, 9000)
        else:
            results[name] = test_connection(host, 80)

    print(f"\n{'=' * 60}")
    print("Summary:")
    print(f"{'=' * 60}")
    passed = sum(1 for v in results.values() if v)
    failed = len(results) - passed
    print(f"  Passed: {passed}")
    print(f"  Failed: {failed}")
    print(f"\nConfigure TAILSCALE_* env vars to enable specific resources.")


if __name__ == "__main__":
    main()
