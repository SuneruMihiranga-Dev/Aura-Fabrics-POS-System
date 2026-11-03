import argparse
import os
import secrets
from pathlib import Path

import pyotp
import qrcode
from qrcode.image.svg import SvgPathImage
from dotenv import dotenv_values, set_key

ENV_FILE = Path(__file__).with_name(".env")
EXAMPLE_FILE = Path(__file__).with_name(".env.example")
LEGACY_WHATSAPP_KEYS = {
    "POS_OTP_PHONE_E164",
    "WHATSAPP_PHONE_NUMBER_ID",
    "WHATSAPP_ACCESS_TOKEN",
    "WHATSAPP_OTP_TEMPLATE",
    "WHATSAPP_OTP_LANGUAGE",
    "WHATSAPP_GRAPH_API_VERSION",
}


def remove_legacy_whatsapp_settings():
    if not ENV_FILE.exists():
        return
    kept_lines = [
        line
        for line in ENV_FILE.read_text().splitlines()
        if line.partition("=")[0].strip() not in LEGACY_WHATSAPP_KEYS
    ]
    ENV_FILE.write_text("\n".join(kept_lines) + "\n")


def main():
    parser = argparse.ArgumentParser(description="Configure a private Aura Fabrics authenticator.")
    parser.add_argument(
        "--qr-file",
        type=Path,
        help="Save a private SVG setup QR here instead of printing it in the terminal.",
    )
    args = parser.parse_args()

    if not ENV_FILE.exists() and EXAMPLE_FILE.exists():
        ENV_FILE.write_text(EXAMPLE_FILE.read_text())

    existing = dotenv_values(ENV_FILE)
    if existing.get("POS_ADMIN_TOTP_SECRET"):
        confirmation = input(
            "An authenticator is already configured. Type RESET to replace it: "
        ).strip()
        if confirmation != "RESET":
            raise SystemExit("Authenticator setup cancelled; existing configuration was preserved.")

    account_name = input("Authenticator account label [Aura Fabrics POS]: ").strip()
    account_name = account_name or "Aura Fabrics POS"
    secret = pyotp.random_base32()
    provisioning_uri = pyotp.TOTP(secret).provisioning_uri(
        name=account_name,
        issuer_name="Aura Fabrics",
    )

    remove_legacy_whatsapp_settings()
    set_key(ENV_FILE, "SECRET_KEY", secrets.token_urlsafe(48), quote_mode="always")
    set_key(ENV_FILE, "POS_ADMIN_TOTP_SECRET", secret, quote_mode="always")
    os.chmod(ENV_FILE, 0o600)

    qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, border=2)
    qr.add_data(provisioning_uri)
    qr.make(fit=True)
    if args.qr_file:
        qr_file = args.qr_file.expanduser().resolve()
        qr_file.parent.mkdir(parents=True, exist_ok=True)
        qr.make_image(image_factory=SvgPathImage).save(str(qr_file))
        os.chmod(qr_file, 0o600)
        print(f"Private authenticator QR saved to {qr_file}")
        print("Scan it from your authenticator app, then delete the QR file.")
    else:
        print("\nScan this QR code from your authenticator app:\n")
        qr.print_ascii(invert=True)
        print("\nIf scanning does not work, enter this setup key manually:")
        print(secret)
        print("\nThe setup key grants access to your POS. Keep it private.")
    print("Authenticator setup is saved in backend/.env with owner-only permissions.")
    print("Restart the Flask API after adding this account to your authenticator app.")


if __name__ == "__main__":
    main()
