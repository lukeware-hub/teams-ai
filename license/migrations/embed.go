package migrations

import _ "embed"

//go:embed 001_schema.sql
var SQL string
