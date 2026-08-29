from flickr8k_visualizer.db import _compose_where_clause


def test_compose_where_clause_groups_each_filter_expression() -> None:
    assert _compose_where_clause(["split = ? OR width >= ?"], "id < ?") == (
        " WHERE (split = ? OR width >= ?) AND (id < ?)"
    )
