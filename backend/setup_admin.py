import os
import secrets
from getpass import getpass
from pathlib import Path

from dotenv import dotenv_values, set_key
from werkzeug.security import generate_password_hash

ENV_FILE = Path(__file__).with_name(".env")
EXAMPLE_FILE = Path(__file__).with_name(".env.example")


def main():
    if not ENV_FILE.exists() and EXAMPLE_FILE.exists():
        ENV_FILE.write_text(EXAMPLE_FILE.read_text())

    while True:
        password = getpass("Choose a POS password (at least 12 characters): ")
        if len(password) < 12:
            print("Use at least 12 characters.")
            continue
        confirmation = getpass("Confirm the POS password: ")
        if password != confirmation:
            print("Passwords do not match. Try again.")
            continue
        break

    set_key(ENV_FILE, "SECRET_KEY", secrets.token_urlsafe(48), quote_mode="always")
    set_key(
        ENV_FILE,
        "POS_ADMIN_PASSWORD_HASH",
        generate_password_hash(password, method="scrypt"),
        quote_mode="always",
    )
    set_key(
        ENV_FILE,
        "SESSION_COOKIE_SECURE",
        dotenv_values(ENV_FILE).get("SESSION_COOKIE_SECURE") or "0",
        quote_mode="always",
    )
    os.chmod(ENV_FILE, 0o600)
    print(f"Sign-in configured. Your password is stored as a hash in {ENV_FILE}.")
    print("Keep this password private. Run this command again to change it.")


if __name__ == "__main__":
    main()
