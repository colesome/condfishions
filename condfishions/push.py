"""Web Push to the phone (iPhone home-screen app, iOS 16.4+).

Needs two GitHub secrets: VAPID_PRIVATE_KEY (and the matching public key as the app's
VAPID_PUBLIC_KEY secret) and optionally VAPID_SUBJECT (mailto:you@example.com).
Make a key pair with:  python scripts/make_vapid_keys.py
Without them, nothing is sent and the app still shows changes on the Trips tab.
"""
from __future__ import annotations

import json
import os


def send(store, title: str, body: str, url: str = "./", tag: str | None = None) -> int:
    """Send to every subscribed device. Returns how many accepted it."""
    key = os.environ.get("VAPID_PRIVATE_KEY", "").strip()
    if not key or not store.enabled:
        return 0
    try:
        from pywebpush import WebPushException, webpush
    except ImportError:
        print("warn: pywebpush not installed; push skipped")
        return 0
    subject = os.environ.get("VAPID_SUBJECT", "").strip() or "mailto:condfishions@example.com"
    try:
        subs = store.select("push_subscriptions", {"select": "endpoint,keys"})
    except RuntimeError as e:
        print(f"warn: could not load push subscriptions ({e})")
        return 0
    payload = json.dumps({"title": title, "body": body, "url": url, "tag": tag})
    sent = 0
    for s in subs:
        try:
            webpush(subscription_info={"endpoint": s["endpoint"], "keys": s["keys"]}, data=payload,
                    vapid_private_key=key, vapid_claims={"sub": subject}, ttl=12 * 3600)
            sent += 1
        except WebPushException as e:
            code = getattr(e.response, "status_code", None)
            if code in (404, 410):  # the phone dropped this subscription
                store.delete_where("push_subscriptions", {"endpoint": f"eq.{s['endpoint']}"})
            else:
                print(f"warn: push failed ({code}): {str(e)[:120]}")
    return sent
