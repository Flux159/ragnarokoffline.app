The localhost certificate and private key are public test fixtures, generated
solely for loopback HTTPS tests. They grant no access to any service and must
never ship in an application payload or be used for hosting. Tests reject this
certificate by default; a separate Node child trusts this exact fixture through
`NODE_EXTRA_CA_CERTS` to exercise successful TLS and downgrade refusal. No system
trust store is changed.
