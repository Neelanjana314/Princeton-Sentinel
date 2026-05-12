import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.runtime_logger import _sanitize_text


class RuntimeLoggerTests(unittest.TestCase):
    def test_sanitize_text_redacts_common_secret_shapes(self):
        message = _sanitize_text(
            'client_secret="super-secret" access_token=abc123 Authorization: Bearer token-value'
        )

        self.assertNotIn("super-secret", message)
        self.assertNotIn("abc123", message)
        self.assertNotIn("token-value", message)
        self.assertIn('client_secret="[REDACTED]"', message)
        self.assertIn("access_token=[REDACTED]", message)
        self.assertIn("Bearer [REDACTED]", message)


if __name__ == "__main__":
    unittest.main()
