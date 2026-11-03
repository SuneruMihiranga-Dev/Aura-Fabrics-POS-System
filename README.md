# Aura Fabrics POS

A point-of-sale web application for a saree boutique in Sri Lanka. It records
sales in LKR, tracks product stock, keeps payment-method and invoice history,
and prints customer bills (including the browser's **Save as PDF** option).
It records cash, card, and bank-transfer payments; it does not process card
details or connect to a payment gateway.

## Stack

- Next.js 15 / React 19 frontend
- Flask REST API with SQLAlchemy
- PostgreSQL 16

## Requirements

Python 3.10+, Node.js 20+, and npm. Local development uses SQLite by default.
PostgreSQL 16 is also supported (Docker Desktop or a local PostgreSQL server).

## Start the application

1. Optional: to use PostgreSQL 16, start the database from the project root:

   ```sh
   cp .env.example .env
   # Edit .env and replace POSTGRES_PASSWORD with a unique, strong password.
   docker compose up -d db
   ```

   `database/init.sql` creates the tables and indexes. After the password setup
   below, set `DATABASE_URL` in `backend/.env` using the same database user and
   password. Otherwise, the POS uses the local SQLite database.

2. In a terminal, install dependencies and securely set the store password:

   ```sh
   cd backend
   python3 -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt
   python3 setup_admin.py
   python3 setup_authenticator.py
   ```

   Choose a unique password with at least 12 characters when prompted. It is
   stored as a scrypt password hash in the ignored, owner-readable `backend/.env`
   file; the password itself is not written to disk. Run `python3 setup_admin.py`
   again to change it.
   The authenticator setup displays a QR code in the terminal. Scan it with an
   authenticator app such as Apple Passwords, Google Authenticator, or Microsoft
   Authenticator. Keep the setup key private. To replace the authenticator, run
   `python3 setup_authenticator.py` again and type `RESET`.
   Local development defaults to the existing SQLite database. To use PostgreSQL,
   set `DATABASE_URL` in `backend/.env` to
   `postgresql+psycopg://pos_user:${POSTGRES_PASSWORD}@localhost:5432/saree_pos`.

3. Start the Flask API in that terminal:

   ```sh
   python3 app.py
   ```

   The API listens only on this computer at `http://localhost:5001/api`. It
   creates any missing database tables at startup. The POS API requires a
   signed-in session for product and sales data, uses an HTTP-only session
   cookie and CSRF tokens, and temporarily rate-limits repeated failed sign-ins.

4. In a second terminal, configure and start the Next.js app:

   ```sh
   cd frontend
   npm install
   printf 'NEXT_PUBLIC_API_URL=http://localhost:5001/api\n' > .env.local
   npm run dev
   ```

   Open `http://localhost:3000`.

Sign-in requires both the store password and a six-digit code from your
authenticator app. Codes rotate every 30 seconds; each sign-in challenge expires
after five minutes and allows up to five code attempts. No SMS or WhatsApp
account is needed.

For an existing installation with a configured password, run
`python3 setup_authenticator.py` from the backend folder, scan the displayed QR
code in your authenticator app, and restart `python3 app.py`. Do not rerun
`setup_admin.py` unless you also want to replace the store password.

## Using the POS

Add products with a unique SKU, name, collection, LKR price, and stock count.
Select products to add them to the current bill, optionally enter a customer
name and discount, choose the recorded payment method, and complete the sale.
Stock is reduced in the same database transaction that saves the sale. Use
**Print / Save PDF** on the invoice to print it or save it as a PDF from the
browser's print dialog. Recent invoices are available under **Sales history**.

To use a different local PostgreSQL instance, set `DATABASE_URL` in
`backend/.env`. To point the frontend at another API, set
`NEXT_PUBLIC_API_URL` in `frontend/.env.local`.

For deployment beyond this computer, use HTTPS, set `SESSION_COOKIE_SECURE=1`,
use a production WSGI server, configure the exact frontend origin, and keep the
secret environment file private. The development server is intended for local
use, not direct internet exposure.
