"""Independent Python reference of the Paradox web-UI login crypto.

Written from the algorithm, not translated line by line from src/paradox.js, so agreement with the
vectors in crypto.json is evidence both implementations are right. This is also the starting point
for the Python port. Run `python3 crypto_reference.py` to check every vector in crypto.json.

JavaScript strings are sequences of UTF-16 code units and the device code only ever looks at the low
byte of each unit, so non-BMP characters count twice; `utf16_units` reproduces that.
"""
import hashlib
import json
import pathlib
import sys


def utf16_units(text):
    raw = text.encode("utf-16-le", "surrogatepass")
    return [int.from_bytes(raw[i:i + 2], "little") for i in range(0, len(raw), 2)]


def keeplowbyte(text):
    return "".join(chr(unit & 0xFF) for unit in utf16_units(text))


def hex_md5(text):
    data = bytes(unit & 0xFF for unit in utf16_units(text))
    return hashlib.md5(data).hexdigest().upper()


def rc4(key, text):
    """RC4 with the firmware's shortened key schedule: one swap per key character, walking the key
    backwards from its last character, with no wrap-around (keys of 257+ characters are undefined)."""
    key_units = utf16_units(key)
    if len(key_units) > 256:
        raise ValueError("key longer than 256 code units is undefined behaviour in the firmware code")
    s = list(range(256))
    y = 0
    for x in range(len(key_units) - 1, -1, -1):
        y = (key_units[x] + s[x] + y) % 256
        s[x], s[y] = s[y], s[x]

    out = []
    y = 0
    for position, unit in enumerate(utf16_units(text)):
        i = position & 255
        y = (s[i] + y) & 255
        s[i], s[y] = s[y], s[i]
        out.append("%02X" % ((unit ^ s[(s[i] + s[y]) % 256]) & 0xFFFF))
    return "".join(out)


def encrypt_credentials(session_value, username, password):
    """Returns (u, p), the query parameters of GET /default.html."""
    key = hex_md5(keeplowbyte(password)) + session_value
    return rc4(key, username), hex_md5(key)


def main():
    spec = json.loads((pathlib.Path(__file__).parent / "crypto.json").read_text(encoding="utf-8"))
    failures = []

    def check(label, actual, expected):
        if actual != expected:
            failures.append("%s: expected %r, got %r" % (label, expected, actual))

    for case in spec["hex_md5"]:
        check("hex_md5 %s" % case["name"], hex_md5(case["input"]), case["expected"])
    for case in spec["keeplowbyte"]:
        check("keeplowbyte %s" % case["name"], keeplowbyte(case["input"]), case["expected"])
    for case in spec["rc4"]:
        if case.get("js_only"):
            continue
        check("rc4 %s" % case["name"], rc4(case["key"], case["text"]), case["expected"])
    for case in spec["credentials"]:
        u, p = encrypt_credentials(case["session"], case["username"], case["password"])
        check("credentials %s u" % case["name"], u, case["u"])
        check("credentials %s p" % case["name"], p, case["p"])

    for failure in failures:
        print("FAIL", failure)
    print("%d failure(s)" % len(failures))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
