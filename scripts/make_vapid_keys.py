"""Make a Web Push key pair for trip alerts.

  python scripts/make_vapid_keys.py

Put the two lines it prints into GitHub → Settings → Secrets and variables → Actions:
  VAPID_PUBLIC_KEY   (used when building the app)
  VAPID_PRIVATE_KEY  (used by the scoring job to send alerts) — keep this one private
"""
import base64

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec


def b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


key = ec.generate_private_key(ec.SECP256R1())
private = key.private_numbers().private_value.to_bytes(32, "big")
public = key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
print(f"VAPID_PUBLIC_KEY={b64(public)}")
print(f"VAPID_PRIVATE_KEY={b64(private)}")
