import re

CAPTION_TERM_PATTERN = re.compile(r"[a-z]+")
ECMASCRIPT_TRIM_CHARACTERS = (
    "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007"
    "\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
)


def caption_terms(text: str) -> list[str]:
    return CAPTION_TERM_PATTERN.findall(text.lower())


def caption_token_count(text: str) -> int:
    return len(text.split())


def trim_caption_query(query: str) -> str:
    return query.strip(ECMASCRIPT_TRIM_CHARACTERS)


def caption_has_term(text: str, term: str) -> bool:
    normalized_term = term.lower()
    if CAPTION_TERM_PATTERN.fullmatch(normalized_term) is None:
        return False
    return normalized_term in caption_terms(text)


def caption_matches_query(text: str, query: str) -> bool:
    if not query:
        return False
    leading_boundary = r"(?<![A-Za-z0-9])" if _is_ascii_alphanumeric(query[0]) else ""
    trailing_boundary = r"(?![A-Za-z0-9])" if _is_ascii_alphanumeric(query[-1]) else ""
    pattern = re.compile(
        f"{leading_boundary}{re.escape(query)}{trailing_boundary}",
        re.ASCII | re.IGNORECASE,
    )
    return pattern.search(text) is not None


def _is_ascii_alphanumeric(character: str) -> bool:
    return character.isascii() and character.isalnum()
