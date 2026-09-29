# Third-party distribution review

Status: **BLOCKED** pending review of the exact release artifacts. This is an engineering inventory and unresolved-work record, not a legal compliance determination. Prior draft suggestions of “zero redistribution risk” or guaranteed compliance are withdrawn.

| Artifact          | Known engineering use                                      | Evidence still required before distribution                                                                                                                                                |
| ----------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SumatraPDF        | Separate portable executable called by the Windows adapter | Approved binary version/hash/provenance, exact corresponding source and bundled component/license inventory, notices and distribution obligations reviewed for the chosen delivery method. |
| Node SEA runtime  | Node executable plus bundled PrintGo script                | Exact Windows Node version/hash and its full applicable notices/dependency inventory.                                                                                                      |
| JavaScript bundle | Workspace dependencies compiled through esbuild            | Lockfile-derived shipped dependency inventory and applicable license/notice review.                                                                                                        |
| Control Center    | C# WinForms source compiled by Windows .NET tooling        | Compiler/runtime prerequisites and review of the actual distribution contents.                                                                                                             |
| Installer         | Inno Setup build plus the above staged payloads            | Applicable installer notices, final payload inventory, publisher signing and tested installation.                                                                                          |

`THIRD_PARTY_NOTICES.txt` is a draft inventory; it is not evidence that all required license texts, notices, sources or offers are included. The package build records the Sumatra digest but cannot decide legal compliance. A checksum cannot substitute for provenance or review.

The packager requires a technician-provided Sumatra executable and independently verified digest. It does not download dependencies on the owner's machine. Changing to download-on-demand would require a separate reviewed design; that alone would not establish absence of legal obligations.

Record reviewer, decision date, exact binary/source hashes, final notices, source delivery locations if applicable, and approved distribution method before changing this gate. No definitive third-party compliance statement is authorized by local test success.
