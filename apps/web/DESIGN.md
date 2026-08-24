# Web design direction

## Subject

RunGuild is an operational cockpit for developers and technical
reviewers. Its first job is to answer: what are the Agents doing, why is the
work allowed to advance, and which exact evidence makes the result trustworthy?

## Tokens

- `cold-paper #EEF1F5`: quiet instrument surface, not a marketing canvas.
- `flight-ink #172033`: primary structure and high-confidence text.
- `route-cobalt #4056E8`: active execution paths and selected controls.
- `hold-amber #E8A62A`: human waits, budgets, and incomplete gates.
- `proof-teal #16836F`: verified evidence and completed gates.
- `fault-coral #D85B52`: rejected or failed state only.

Display type is Bricolage Grotesque, used only for Mission names and decisive
numbers. Manrope carries product copy. IBM Plex Mono identifies commits,
durations, tokens, and event sequence values.

## Layout

The page behaves like an engineering instrument: narrow navigation, a wide
Mission topology surface, and a persistent evidence rail.

~~~text
+------+--------------------------------------+------------------+
| nav  | mission contract                     | system / actions |
|      +--------------------------------------+------------------+
|      |                                      |                  |
|      |       dependency topology            | evidence spine   |
|      |       selected Task expands          | live event chain |
|      |                                      |                  |
|      +----------------------+---------------+                  |
|      | selected run detail  | agent roster  |                  |
+------+----------------------+---------------+------------------+
~~~

## Signature

The Evidence Spine is a vertical, numbered chain whose nodes are durable facts,
not decorative steps. Selecting a Task filters the chain to the proof that can
advance that Task.

## Self-critique

An early direction used a dark background with green status lights. That is a
common AI dashboard default and weakens the distinction between evidence and
decoration. The revised cold-paper cockpit spends saturated color only on
execution semantics. Large gradient KPI cards and glass panels were removed;
the DAG and Evidence Spine carry the identity instead.
