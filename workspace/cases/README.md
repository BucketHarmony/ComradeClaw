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
| star-house-nyc-1970 | STAR House (Street Transvestite Action Revolutionaries) | East Village NYC | 1970-1974 | No | Semi |
| berkeley-cil-1972 | Berkeley Center for Independent Living | Berkeley CA | 1972-present | Yes | Public |
| roscas-banker-ladies | Roscas — African Diaspora Rotating Credit Circles | Global diaspora | Centuries-present | Yes | Invisible |

---

## Anti-Capture Mechanism Index

Groups cases by the anti-capture mechanism they exemplify. A case can appear under multiple mechanisms. Use this to query the registry by theory dimension rather than by case name — e.g., when arguing for structural governance requirements, see which cases demonstrate it held under pressure.

---

### peer-funded
*Sustained by participants' own resources — no grants, no institutional funders, no capture vector through funding dependency.*

- **STAR House** — founders sustained the house through their own sex work earnings. No 501c3 during active period. The funding mechanism and the governance mechanism were the same: the people most at risk controlled the resources.
- **Roscas** — rotating member contributions fund each other. No external capital, no lender, no regulator. The pool is the only institution.

---

### distributed-nodes
*Infrastructure spread across many independent units before any targeting occurs. No single killable center. Destroying one node doesn't reach the others.*

- **BPP Free Breakfast** — 45 city chapters running before the FBI targeted national leadership. Content distributed before form was attacked.
- **Zapatista GAL Restructuring** — dissolved centralized juntas, replaced with thousands of Local Autonomous Governments at base community level. Reactive distribution, but the move was structural.
- **Berkeley CIL** — 400+ independent centers globally. Each locally governed. The model spread; no center controls the others.
- **Roscas** — each circle is independent. Seizing one doesn't touch the network.

---

### structural-governance
*Anti-capture written into founding documents or bylaws — not just practice, but constitutional requirement. Holdable under absorption pressure.*

- **Berkeley CIL** — 51% of board and staff required to have disabilities. The rule survived ADA partial absorption and federal funding conditions. No non-disabled professional majority can form legally.
- **Paris Commune** — elected delegates paid working wages, subject to immediate recall by constituents. Governance designed to prevent delegation from becoming delegation of power.

---

### outsider-by-design
*Explicitly positioned outside or in opposition to mainstream advocacy. Absorption impossible because the founding posture rejects the capture vector's terms.*

- **STAR House** — Rivera's explicit rejection of respectability politics, plus active expulsion from mainstream LGB organizing (1973 NYC Pride). Anti-respectability architecture was foundational, not incidental. The mainstream movement's response was exclusion, not absorption — which is a different failure mode but the same outcome for state capture.

---

### chosen-family
*Informal trust hierarchy replaces formal board governance. No bylaws, no NGO structure, no legal entity for capture to operate through.*

- **STAR House** — house mother/father model. Governance through relationship and responsibility, not charter.
- **Roscas** — social capital enforces obligations. No contracts, no legal claim surface. Default consequences are relational, not legal — which makes them more effective within the community and invisible to outside enforcement.

---

### replication-without-center
*Model spreads through adoption and local instantiation, not franchise or headquarters control. Killing the original doesn't stop the spread.*

- **Berkeley CIL** — the model (peer governance, majority-disabled requirement, anti-medical-model framing) spread to 400+ centers without Berkeley controlling any of them.
- **BPP Free Breakfast** — chapter model meant each city program was locally run. Hampton's assassination didn't end breakfast programs in other cities.

---

### transaction-level-illegibility
*Individual operations invisible to surveillance at the point of transaction. Not just organizational invisibility — operational security at every exchange.*

- **Roscas** — oral tradition, no records, social-capital enforcement. Individual contributions and receipts leave no financial trace legible to banking surveillance or tax authorities.
- **Hillsboro Underground Mutual Aid** — code names, printed directions, encrypted messaging, brief deliveries. Every data point (addresses, routes, names, times) deliberately illegible.

---

### deed-as-argument + enrollment (Fifth Question)
*Infrastructure that simultaneously provides service, demonstrates state dispensability, AND enrolls participants in the organizational form capable of confronting the power named. The deed, the argument, and the recruitment are the same act.*

- **BPP Free Breakfast** — meal → chapter membership → political education → Rainbow Coalition. Each service proved state dispensability and was also the door into confrontational organizing. Passes all five evaluation questions.
- **Berkeley CIL** — peer counseling → disability rights consciousness → ADA advocacy → nursing home industry confrontation. The service was the argument; the argument built the movement that changed federal law.

*Cases that pass questions 1-4 but fail the fifth question by design:*
- **Hillsboro** — makes the argument (state not required for community provision) but cannot enroll. Illegibility is anti-capture but also anti-recruitment. The tension is structural, not a failure.
- **Roscas** — historically connected to formal organizing (startup capital for cooperative businesses), but the connection is indirect and varies by community. The fifth question applies unevenly.

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
