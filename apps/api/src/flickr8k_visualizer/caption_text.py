import re

CAPTION_TERM_PATTERN = re.compile(r"[a-z]+")


def caption_terms(text: str) -> list[str]:
    return CAPTION_TERM_PATTERN.findall(text.lower())


def caption_token_count(text: str) -> int:
    return len(text.split())


def caption_has_term(text: str, term: str) -> bool:
    normalized_term = term.lower()
    if CAPTION_TERM_PATTERN.fullmatch(normalized_term) is None:
        return False
    return normalized_term in caption_terms(text)
