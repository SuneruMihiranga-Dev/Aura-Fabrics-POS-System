import os
import hmac
import secrets
import threading
import uuid
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

from dotenv import load_dotenv
from flask import Flask, jsonify, request, session
from flask_cors import CORS
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
import pyotp
from werkzeug.security import check_password_hash

load_dotenv()

db = SQLAlchemy()
CENT = Decimal("0.01")
PAYMENT_METHODS = {"cash", "card", "bank_transfer"}
LOGIN_WINDOW = timedelta(minutes=15)
LOGIN_ATTEMPT_LIMIT = 5
OTP_ATTEMPT_LIMIT = 5
login_attempts = defaultdict(deque)
login_attempts_lock = threading.Lock()
authenticator_attempts = defaultdict(deque)
authenticator_attempts_lock = threading.Lock()


def parse_bool(value):
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def money(value):
    return Decimal(str(value)).quantize(CENT, rounding=ROUND_HALF_UP)


class Product(db.Model):
    __tablename__ = "products"

    id = db.Column(db.Integer, primary_key=True)
    sku = db.Column(db.String(40), unique=True, nullable=False)
    name = db.Column(db.String(160), nullable=False)
    category = db.Column(db.String(80), nullable=False, default="Saree")
    price = db.Column(db.Numeric(12, 2), nullable=False)
    stock_quantity = db.Column(db.Integer, nullable=False, default=0)
    active = db.Column(db.Boolean, nullable=False, default=True)
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=db.func.now())

    def as_dict(self):
        return {
            "id": self.id,
            "sku": self.sku,
            "name": self.name,
            "category": self.category,
            "price": float(self.price),
            "stock_quantity": self.stock_quantity,
        }


class Sale(db.Model):
    __tablename__ = "sales"

    id = db.Column(db.Integer, primary_key=True)
    invoice_number = db.Column(db.String(40), unique=True, nullable=False)
    customer_name = db.Column(db.String(160))
    payment_method = db.Column(db.String(24), nullable=False)
    subtotal = db.Column(db.Numeric(12, 2), nullable=False)
    discount = db.Column(db.Numeric(12, 2), nullable=False, default=0)
    total = db.Column(db.Numeric(12, 2), nullable=False)
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=db.func.now())
    items = db.relationship("SaleItem", back_populates="sale", cascade="all, delete-orphan")

    def as_dict(self):
        return {
            "id": self.id,
            "invoice_number": self.invoice_number,
            "customer_name": self.customer_name,
            "payment_method": self.payment_method,
            "subtotal": float(self.subtotal),
            "discount": float(self.discount),
            "total": float(self.total),
            "created_at": self.created_at.isoformat(),
            "items": [item.as_dict() for item in self.items],
        }


class SaleItem(db.Model):
    __tablename__ = "sale_items"

    id = db.Column(db.Integer, primary_key=True)
    sale_id = db.Column(db.Integer, db.ForeignKey("sales.id", ondelete="CASCADE"), nullable=False)
    product_id = db.Column(db.Integer, db.ForeignKey("products.id", ondelete="SET NULL"))
    product_name = db.Column(db.String(160), nullable=False)
    sku = db.Column(db.String(40), nullable=False)
    quantity = db.Column(db.Integer, nullable=False)
    unit_price = db.Column(db.Numeric(12, 2), nullable=False)
    line_total = db.Column(db.Numeric(12, 2), nullable=False)
    sale = db.relationship("Sale", back_populates="items")

    def as_dict(self):
        return {
            "product_id": self.product_id,
            "product_name": self.product_name,
            "sku": self.sku,
            "quantity": self.quantity,
            "unit_price": float(self.unit_price),
            "line_total": float(self.line_total),
        }


class LoginChallenge(db.Model):
    __tablename__ = "login_challenges"

    id = db.Column(db.String(36), primary_key=True)
    otp_hash = db.Column(db.String(64), nullable=False)
    expires_at = db.Column(db.Float, nullable=False)
    attempts = db.Column(db.Integer, nullable=False, default=0)
    consumed = db.Column(db.Boolean, nullable=False, default=False)


def create_app():
    app = Flask(__name__)
    secret_key = os.getenv("SECRET_KEY")
    password_hash = os.getenv("POS_ADMIN_PASSWORD_HASH")
    authenticator_secret = os.getenv("POS_ADMIN_TOTP_SECRET")
    if not secret_key or not password_hash or not authenticator_secret:
        raise RuntimeError(
            "POS sign-in is not configured. Run `python3 setup_admin.py` and "
            "`python3 setup_authenticator.py` from the backend folder."
        )
    try:
        pyotp.TOTP(authenticator_secret).now()
    except (TypeError, ValueError):
        raise RuntimeError("POS_ADMIN_TOTP_SECRET is invalid. Run `python3 setup_authenticator.py`.") from None

    app.config["SQLALCHEMY_DATABASE_URI"] = os.getenv(
        "DATABASE_URL",
        "sqlite:///saree_pos_dev.sqlite3",
    )
    app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
    app.config.update(
        SECRET_KEY=secret_key,
        SESSION_COOKIE_NAME="aura_session",
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SECURE=parse_bool(os.getenv("SESSION_COOKIE_SECURE", "0")),
        SESSION_COOKIE_SAMESITE="Lax",
        PERMANENT_SESSION_LIFETIME=timedelta(hours=8),
        MAX_CONTENT_LENGTH=1 * 1024 * 1024,
    )
    db.init_app(app)
    CORS(
        app,
        resources={r"/api/*": {"origins": os.getenv("FRONTEND_ORIGIN", "http://localhost:3000")}},
        supports_credentials=True,
        allow_headers=["Content-Type", "X-CSRF-Token"],
    )

    with app.app_context():
        db.create_all()

    @app.before_request
    def require_authentication_and_csrf():
        if not request.path.startswith("/api/"):
            return None
        if request.method == "OPTIONS" or request.path in {
            "/api/health",
            "/api/auth/session",
            "/api/auth/login",
            "/api/auth/verify",
        }:
            return None
        if not session.get("authenticated"):
            return jsonify({"error": "Please sign in to continue."}), 401
        if request.method not in {"GET", "HEAD"}:
            expected_token = session.get("csrf_token", "")
            supplied_token = request.headers.get("X-CSRF-Token", "")
            if not expected_token or not hmac.compare_digest(expected_token, supplied_token):
                return jsonify({"error": "Your session expired. Please sign in again."}), 403
        session.permanent = True
        return None

    @app.after_request
    def set_security_headers(response):
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        response.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        if request.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.get("/api/health")
    def health():
        db.session.execute(db.text("SELECT 1"))
        return jsonify({"status": "ok"})

    @app.get("/api/auth/session")
    def auth_session():
        if not session.get("authenticated"):
            return jsonify({"authenticated": False, "csrf_token": None})
        session.permanent = True
        return jsonify({"authenticated": True, "csrf_token": session.get("csrf_token")})

    @app.post("/api/auth/login")
    def login():
        client_ip = request.remote_addr or "unknown"
        now = datetime.now(timezone.utc)
        with login_attempts_lock:
            attempts = login_attempts[client_ip]
            while attempts and now - attempts[0] >= LOGIN_WINDOW:
                attempts.popleft()
            if len(attempts) >= LOGIN_ATTEMPT_LIMIT:
                return jsonify({"error": "Too many sign-in attempts. Please wait 15 minutes and try again."}), 429

        data = request.get_json(silent=True) or {}
        password = data.get("password")
        if not isinstance(password, str) or not check_password_hash(password_hash, password):
            with login_attempts_lock:
                login_attempts[client_ip].append(now)
            return jsonify({"error": "The password you entered is incorrect."}), 401

        challenge_id = str(uuid.uuid4())
        db.session.execute(
            delete(LoginChallenge).where(
                (LoginChallenge.consumed.is_(True))
                | (LoginChallenge.expires_at <= now.timestamp())
            )
        )
        challenge = LoginChallenge(
            id=challenge_id,
            otp_hash="",
            expires_at=now.timestamp() + timedelta(minutes=5).total_seconds(),
        )
        db.session.add(challenge)
        db.session.commit()

        return jsonify({
            "otp_required": True,
            "challenge_id": challenge_id,
            "expires_in": 300,
        })

    @app.post("/api/auth/verify")
    def verify_otp():
        client_ip = request.remote_addr or "unknown"
        now = datetime.now(timezone.utc)
        with login_attempts_lock:
            attempts = login_attempts[client_ip]
            while attempts and now - attempts[0] >= LOGIN_WINDOW:
                attempts.popleft()
            if len(attempts) >= LOGIN_ATTEMPT_LIMIT:
                return jsonify({"error": "Too many verification attempts. Please wait 15 minutes and try again."}), 429
        with authenticator_attempts_lock:
            code_attempts = authenticator_attempts[client_ip]
            while code_attempts and now - code_attempts[0] >= LOGIN_WINDOW:
                code_attempts.popleft()
            if len(code_attempts) >= LOGIN_ATTEMPT_LIMIT:
                return jsonify({"error": "Too many incorrect authenticator codes. Please wait 15 minutes and try again."}), 429

        data = request.get_json(silent=True) or {}
        challenge_id = data.get("challenge_id")
        code = data.get("code")
        if not isinstance(challenge_id, str) or not isinstance(code, str) or not code.isdigit() or len(code) != 6:
            return jsonify({"error": "Enter the current 6-digit code from your authenticator app."}), 400

        challenge = db.session.get(LoginChallenge, challenge_id)
        if challenge is None or challenge.consumed:
            return jsonify({"error": "This sign-in attempt is no longer valid. Enter your password again."}), 401
        if now.timestamp() >= challenge.expires_at:
            challenge.consumed = True
            db.session.commit()
            return jsonify({"error": "This verification code has expired. Sign in again to get a new code."}), 401
        if challenge.attempts >= OTP_ATTEMPT_LIMIT:
            challenge.consumed = True
            db.session.commit()
            return jsonify({"error": "Too many incorrect codes. Enter your password again to start a new sign-in."}), 429

        challenge.attempts += 1
        if not pyotp.TOTP(authenticator_secret).verify(code, valid_window=1):
            if challenge.attempts >= OTP_ATTEMPT_LIMIT:
                challenge.consumed = True
            db.session.commit()
            with authenticator_attempts_lock:
                authenticator_attempts[client_ip].append(now)
            return jsonify({"error": "That code is incorrect. Check your authenticator app and try again."}), 401

        challenge.consumed = True
        db.session.commit()
        with login_attempts_lock:
            login_attempts.pop(client_ip, None)
        with authenticator_attempts_lock:
            authenticator_attempts.pop(client_ip, None)
        session.clear()
        session["authenticated"] = True
        session["csrf_token"] = secrets.token_urlsafe(32)
        session.permanent = True
        return jsonify({"authenticated": True, "csrf_token": session["csrf_token"]})

    @app.post("/api/auth/logout")
    def logout():
        session.clear()
        response = jsonify({"authenticated": False})
        response.delete_cookie(
            app.config["SESSION_COOKIE_NAME"],
            httponly=True,
            secure=app.config["SESSION_COOKIE_SECURE"],
            samesite=app.config["SESSION_COOKIE_SAMESITE"],
        )
        return response

    @app.get("/api/products")
    def list_products():
        products = db.session.scalars(
            select(Product).where(Product.active.is_(True)).order_by(Product.name)
        ).all()
        return jsonify([product.as_dict() for product in products])

    @app.post("/api/products")
    def create_product():
        data = request.get_json(silent=True) or {}
        try:
            sku = str(data.get("sku", "")).strip().upper()
            name = str(data.get("name", "")).strip()
            category = str(data.get("category", "Saree")).strip() or "Saree"
            price = money(data.get("price", ""))
            stock = int(data.get("stock_quantity", 0))
            if not sku or not name or not price.is_finite() or price <= 0 or stock < 0:
                raise ValueError
        except (ValueError, TypeError, InvalidOperation):
            return jsonify({"error": "Enter a SKU, product name, positive price, and valid stock quantity."}), 400

        product = Product(sku=sku, name=name, category=category, price=price, stock_quantity=stock)
        db.session.add(product)
        try:
            db.session.commit()
        except IntegrityError:
            db.session.rollback()
            return jsonify({"error": "That SKU is already in use."}), 409
        return jsonify(product.as_dict()), 201

    @app.get("/api/sales")
    def list_sales():
        sales = db.session.scalars(select(Sale).order_by(Sale.created_at.desc()).limit(100)).all()
        return jsonify([sale.as_dict() for sale in sales])

    @app.post("/api/sales")
    def create_sale():
        data = request.get_json(silent=True) or {}
        try:
            payment_method = str(data.get("payment_method", "")).strip()
            if payment_method not in PAYMENT_METHODS:
                raise ValueError("Choose cash, card, or bank transfer.")
            raw_items = data.get("items")
            if not isinstance(raw_items, list) or not raw_items:
                raise ValueError("Add at least one item to the sale.")
            quantities = {}
            for item in raw_items:
                product_id = int(item["product_id"])
                quantity = int(item["quantity"])
                if quantity < 1:
                    raise ValueError("Item quantities must be at least one.")
                quantities[product_id] = quantities.get(product_id, 0) + quantity
            discount = money(data.get("discount", 0))
            if not discount.is_finite() or discount < 0:
                raise ValueError("Discount must be a finite, non-negative amount.")
        except (ValueError, TypeError, KeyError, InvalidOperation) as error:
            return jsonify({"error": str(error) or "Enter valid sale details."}), 400

        products = db.session.scalars(
            select(Product)
            .where(Product.id.in_(quantities), Product.active.is_(True))
            .order_by(Product.id)
            .with_for_update()
        ).all()
        by_id = {product.id: product for product in products}
        if len(by_id) != len(quantities):
            db.session.rollback()
            return jsonify({"error": "One or more selected products are no longer available."}), 409

        subtotal = Decimal("0.00")
        sale_items = []
        for product_id, quantity in quantities.items():
            product = by_id[product_id]
            if product.stock_quantity < quantity:
                db.session.rollback()
                return jsonify({"error": f"Not enough stock for {product.name}. Available: {product.stock_quantity}."}), 409
            line_total = money(product.price * quantity)
            subtotal += line_total
            sale_items.append(
                SaleItem(
                    product_id=product.id,
                    product_name=product.name,
                    sku=product.sku,
                    quantity=quantity,
                    unit_price=product.price,
                    line_total=line_total,
                )
            )
        subtotal = money(subtotal)
        if discount > subtotal:
            db.session.rollback()
            return jsonify({"error": "Discount cannot exceed the subtotal."}), 400

        sale = Sale(
            invoice_number=f"SB-{datetime.now().strftime('%Y%m%d')}-{uuid.uuid4().hex[:6].upper()}",
            customer_name=(str(data.get("customer_name", "")).strip() or None),
            payment_method=payment_method,
            subtotal=subtotal,
            discount=discount,
            total=money(subtotal - discount),
            items=sale_items,
        )
        for product_id, quantity in quantities.items():
            by_id[product_id].stock_quantity -= quantity
        db.session.add(sale)
        try:
            db.session.commit()
        except Exception:
            db.session.rollback()
            raise
        return jsonify(sale.as_dict()), 201

    @app.errorhandler(404)
    def not_found(_error):
        return jsonify({"error": "Not found."}), 404

    return app


app = create_app()

if __name__ == "__main__":
    app.run(
        host="127.0.0.1",
        port=int(os.getenv("PORT", "5001")),
        debug=parse_bool(os.getenv("FLASK_DEBUG", "0")),
    )
