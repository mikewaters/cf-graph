# Domain Entities

The core domain model expressed as a property graph. Every entity is a **node** with a `kind`, a `title`, and a JSON `properties` bag. Relationships between entities are described here in natural language; see [IMPLEMENTATION_MODEL.md](./IMPLEMENTATION_MODEL.md) for how they are stored and queried.

All entities carry `id` (CURIE), `title`, `description`, `tags`, `created_at`, and `updated_at`. Only distinguishing properties are listed below.

---

## Concerns

A Concern is something you care about — a commitment of attention over time. All concern subtypes share `concern_type`, `concern_status` (active / dormant / closed), `concern_start`, and `concern_target_date`. Concerns can be nested via `parent_concern`.

| Kind | Description |
|------|-------------|
| **ProjectConcern** | A bounded initiative with a deliverable and target date. |
| **GoalConcern** | A measurable outcome to achieve. |
| **AreaConcern** | An ongoing area of responsibility (health, finances, career). |
| **RoutineConcern** | A recurring operational pattern to maintain. |
| **LogConcern** | A running log of observations or activity in an area. |
| **LearningConcern** | A learning objective or course of study. |

---

## Problems, Risks, and Conditions

Entities that describe challenges, vulnerabilities, and environmental factors.

| Kind | Description | Key Properties |
|------|-------------|----------------|
| **Struggle** | An ongoing difficulty you're working through. | severity, root_causes, coping_strategies |
| **Worry** | A source of anxiety about a possible future. | anxiety_level, likelihood, worst_case_scenario |
| **Emergency** | An urgent, time-bound crisis requiring action. | deadline, consequences_if_unresolved, immediate_actions |
| **Risk** | A potential future event with negative impact. | probability, impact, likelihood_trend, time_horizon, mitigation_strategies |
| **HealthCondition** | A medical or physical condition. | diagnosis, treatment_plan, prognosis |
| **EnvironmentalCondition** | An external condition affecting you. | location, controllable, adaptation_required |
| **SystemCondition** | A condition within a system you depend on. | system_name, system_type, workarounds |
| **Hazard** | A persistent source of danger or exposure. | threat_level, exposure_frequency, preventive_measures |

---

## Capabilities and Effectiveness

| Kind | Description | Key Properties |
|------|-------------|----------------|
| **Capability** | What an entity can do — abilities and gaps. | abilities, limitations, readiness_level, development_plan |
| **Effectiveness** | A point-in-time assessment of how well something works. | capacity_score, condition_score, overall_rating, bottlenecks |

---

## Topics and Taxonomies

Topics are the information backbone — they classify what things are *about*.

| Kind | Description | Key Properties |
|------|-------------|----------------|
| **TopicTaxonomy** | A named collection of topics forming a hierarchy. | created_by |
| **Topic** | A subject or theme within a taxonomy. Topics form trees via parent-child relationships. | slug, aliases, materialized_path |
| **Match** | A cross-reference linking a local entity to an external system identifier. | entity_type, external_system, external_id, match_type, confidence |

---

## Identity and Values

Who you are and what matters.

| Kind | Description | Key Properties |
|------|-------------|----------------|
| **Organism** | The person at the center of the system. | name, givenName, familyName, birthday, topic_interest |
| **Role** | A social or professional role you occupy. | — |
| **Archetype** | A pattern or model you aspire to or identify with. | — |
| **Value** | A core value or priority. | — |
| **Principle** | A guiding rule derived from values. | — |

---

## Behaviors

How you operate — methods, processes, routines, habits.

| Kind | Description | Key Properties |
|------|-------------|----------------|
| **Method** | A deliberate technique or approach. | — |
| **Process** | A multi-step procedure. | — |
| **Routine** | A recurring scheduled practice. | recurrence_pattern, estimated_time |
| **Habit** | An automatic behavioral pattern. | trigger, automated |

All behaviors can link to the Principles they enact and the Goals they implement.

---

## Purpose

Direction-setting entities.

| Kind | Description | Key Properties |
|------|-------------|----------------|
| **Vision** | A long-term aspirational picture. | time_horizon |
| **Goal** | A concrete, measurable target. | target_date, measurable_criteria |
| **Outcome** | A change in state that has happened or is expected. | — |
| **Action** | A discrete step that produces change. | — |

---

## Work

How effort is organized and tracked.

| Kind | Description | Key Properties |
|------|-------------|----------------|
| **Effort** | A strategic body of work spanning multiple activities. | status |
| **Activity** | A concrete unit of work. | activity_type, status, start_date, due_date |

---

## World

People, objects, and communities.

| Kind | Description | Key Properties |
|------|-------------|----------------|
| **Person** | An individual. | contact_info |
| **Relationship** | A connection between you and a person. | relationship_type, since_date, relationship_status |
| **Community** | A group of people with shared purpose. | member_list, community_purpose |
| **PhysicalObject** | A tangible thing. | — |
| **DigitalObject** | A digital artifact (file, app, service). | — |
| **Asset** | An object with tracked usage and age. | uses_object, has_usage, has_age |

---

## Knowledge

Resources are the knowledge artifacts — what you read, write, collect, and annotate.

All resources share: `format`, `media_type`, `resource_type`, `source_system`, `sync_status`, and rich inter-resource relationships (references, derives_from, supersedes, contradicts, elaborates).

| Kind | Description | Key Properties |
|------|-------------|----------------|
| **Note** | A short-form written artifact. | note_type (Note, Log, Thought, Idea, Reference, Highlight) |
| **Document** | A long-form written artifact. | document_type (Document, Journal, List, Notebook, Logbook, Inventory, Landscape) |
| **Bookmark** | A saved reference to an external URL. | favicon_url |
| **Highlight** | An excerpt from another resource. | source_passage_text, source_location |
| **Collection** | A curated grouping of resources. | — |
| **Catalog** | A thematic catalog of resources. | themes |
| **Repository** | A storage backend (local, cloud, version control). | service_name, repository_type, web_url |
| **Annotation** | A machine or human annotation on a resource. | annotation_type, value_concept, confidence, status |

---

## Enums (selected)

| Enum | Values |
|------|--------|
| ConcernStatus | active, dormant, closed |
| ConcernType | project, goal, area, routine, learning, log, custom |
| Severity | LOW, MEDIUM, HIGH, CRITICAL |
| EffortStatus | proposed, committed, active, paused, completed, retired |
| ActivityStatus | draft, active, paused, completed, abandoned |
| NoteType | Note, Log, Thought, Idea, Reference, Highlight |
| DocumentType | Document, Journal, List, Notebook, Logbook, Inventory, Landscape |
| ResourceStatus | draft, active, archived, deprecated, merged |
| RelationshipType | family, friend, colleague, mentor, coach, collaborator, acquaintance, professional, romantic |
| ReadinessLevel | UNPREPARED, DEVELOPING, READY, PROFICIENT, EXPERT |
