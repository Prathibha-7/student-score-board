import os
from typing import Any

import mysql.connector


def connect() -> Any:
    required = ("DB_HOST", "DB_USER", "DB_NAME")
    missing = [key for key in required if not os.getenv(key)]
    if missing:
        raise RuntimeError(f"Missing database environment variables: {', '.join(missing)}")
    options = {
        "host": os.environ["DB_HOST"],
        "port": int(os.getenv("DB_PORT", "3306")),
        "user": os.environ["DB_USER"],
        "password": os.getenv("DB_PASSWORD", ""),
        "database": os.environ["DB_NAME"],
        "charset": "utf8mb4",
        "collation": "utf8mb4_unicode_ci",
        "autocommit": False,
    }
    ca_file = os.getenv("DB_SSL_CA")
    if ca_file:
        options.update(
            ssl_ca=ca_file,
            ssl_verify_cert=True,
            ssl_verify_identity=True,
        )
    return mysql.connector.connect(**options)