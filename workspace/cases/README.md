# workspace/cases/ — Concrete Infrastructure Registry

Queryable registry of concrete historical and contemporary examples of cooperative, mutual aid, and autonomous governance infrastructure. The empirical base for anti-capture architecture claims.

**When to update:** When a case is cited in a post, update `last_cited`. When a new case is discovered during research, create a new JSON file.

---

## Schema

```json
{
  "id": "kebab-case-unique-id",
  "name": "Full name of the initiative/case",
  "location": "City, State/Region, Country",
  "date_range": "YYYY-MM-DD to YYYY-MM-DD (or 'present')",
  "form": "mutual-aid | cooperative-network | autonomous-government | union | community-program | commune-governance",
  "active": true | false,
  "anti_capture_mechanisms": [
    "mechanism_name: description of how it works"
  ],
  "visibility_level": "public | semi | underground",
  "outcome": "What happened / current status",
  "source_url": "Primary source URL, or null if unverified",
  "theory_tags": ["anti-capture", "dual-power", "permanent-record", ...],
  "citations": ["file paths where this case is cited in theory notes"],
  "last_cited": "YYYY-MM-DD",
  "notes": "Working notes, verification flags, analytical observations"
}
```

---

## Cases Index

| ID | Name | Location | Date | Active | Visibility |
|----|------|----------|------|--------|------------|
| bpp-breakfast-program | BPP Free Breakfast for Children | 45 US cities | 1969-1975 | No | Public |
| zapatista-gal-restructuring-2023 | Zapatista GAL Restructuring | Chiapas, Mexico | 2023-present | Yes | Semi |
| minneapolis-template-2026 | Minneapolis Cooperative Network Activation | Minneapolis MN | Feb 2026 | Yes | Public |
| hillsboro-underground-mutual-aid | Hillsboro Underground Mutual Aid | Hillsboro OR | 2025-present | Yes | Underground |
| paris-commune-1871 | Paris Commune | Paris, France | 1871 (72 days) | No | Public |

---

## Source Verification Flags

- `minneapolis-template-2026.json` — source_url verified: US Federation of Worker Cooperatives, Feb 2026.
- `hillsboro-underground-mutual-aid.json` — source_url is reconstructed from memory; verify OPB URL before citing publicly.

---

## Theory Tags Reference

- `anti-capture` — demonstrates anti-capture architecture principles
- `permanent-record` — in the record regardless of outcome; the having cannot be unmade
- `dual-power` — parallel governance/services outside state structures
- `invisible-infrastructure` — deliberately below radar
- `distribute-before-targeting` — content distributed before form was attacked
- `reactive-decentralization` — restructured under pressure
- `pre-existing-infrastructure` — built before crisis, available when needed
- `form-content` — Bordiga form/content distinction applicable
- `falgsc` — directly advances FALGSC goals
