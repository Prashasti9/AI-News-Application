"""Print a new pair of Web Push (VAPID) keys.

Run once, then set the values as VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY on your
host. Keep them forever: if they change, phones stop receiving notifications.

    python -m scripts.generate_vapid
"""

from app.push import generate_vapid_keys

public, private = generate_vapid_keys()
print(f"VAPID_PUBLIC_KEY={public}")
print(f"VAPID_PRIVATE_KEY={private}")
