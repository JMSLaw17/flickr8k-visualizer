from flickr8k_visualizer.db import compose_where_clause


def testcompose_where_clause_groups_each_filter_expression() -> None:
    assert compose_where_clause(["split = ? OR width >= ?"], "id < ?") == (
        " WHERE (split = ? OR width >= ?) AND (id < ?)"
    )
