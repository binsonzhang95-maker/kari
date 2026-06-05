// Package web holds the embedded single-tenant console (built from client-web).
package web

import "embed"

//go:embed dist
var FS embed.FS
