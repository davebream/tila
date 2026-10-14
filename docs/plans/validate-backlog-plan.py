#!/usr/bin/env python3
"""Validate the persisted 2026-10-14 plan, without network or application state."""
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
DAG_PATH = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / '2026-10-14-backlog-dag.json'
DATA = json.loads(DAG_PATH.read_text())
EXPECTED_ISSUES = {450, 449, 448, 440, 439, 416, 400, 399, 398, 362, 308, 307, 292, 283, 261, 194}
EXPECTED_PRS = {314, 312, 311}


def require(condition, message):
    if not condition:
        raise SystemExit(f'INVALID: {message}')


def topological_layers(nodes, edges):
    remaining = set(nodes)
    done = set()
    result = []
    while remaining:
        ready = sorted(
            node for node in remaining
            if all(edge['before'] in done for edge in edges if edge['after'] == node)
        )
        require(ready, f'cycle among {sorted(remaining)}')
        result.append(ready)
        done.update(ready)
        remaining.difference_update(ready)
    return result


def slug(text):
    text = re.sub(r'[^\w\- ]', '', text.lower())
    return text.replace(' ', '-')


nodes = {node['id']: node for node in DATA['nodes']}
require(len(nodes) == len(DATA['nodes']), 'duplicate node IDs')
inventory = DATA['inventory']
keys = [(item['kind'], item['number']) for item in inventory]
require(len(keys) == len(set(keys)), 'duplicate snapshot item')
for item in DATA.get('followup_inventory', []):
    require(item.get('source') and item.get('nodes'), 'unsourced execution follow-up')
    for node_id in item['nodes']:
        require(node_id in nodes and nodes[node_id]['issue'] == item['number'], 'follow-up ownership mismatch')
require({n for kind, n in keys if kind == 'issue'} == EXPECTED_ISSUES, 'open issue coverage')
require({n for kind, n in keys if kind == 'pr'} == EXPECTED_PRS, 'snapshot PR coverage')
for item in inventory:
    require(item['nodes'], f'item {item["number"]} has no disposition nodes')
    for node_id in item['nodes']:
        require(node_id in nodes, f'unknown inventory node {node_id}')
        key = 'issue' if item['kind'] == 'issue' else 'pr'
        require(nodes[node_id][key] == item['number'], f'wrong owner for {node_id}')
    for node_id in item['completion_nodes']:
        require(node_id in item['nodes'], f'completion node outside item {item["number"]}')
    if item['number'] == 261:
        require(item['completion_nodes'] == [], 'dashboard must not acquire a closure task')
    else:
        require(item['completion_nodes'], f'missing completion contract: {item["number"]}')

plan_text = (HERE / DATA['plan']).read_text()
anchors = {slug(line.lstrip('#').strip()) for line in plan_text.splitlines() if line.startswith('#')}
profiles = DATA['validation_profiles']
for node in nodes.values():
    target, _, anchor = node['contract'].partition('#')
    require((HERE / target).is_file(), f'missing contract {target}')
    require(not anchor or anchor in anchors, f'missing heading {anchor}')
    for path in node['source_targets']:
        require((ROOT / path).exists(), f'missing source anchor: {path}')
    require(set(node['validation']) <= set(profiles), f'unknown validation profile: {node["id"]}')
    if node['kind'] == 'builder':
        require(node['owner'] in {'A', 'B', 'C'}, f'unbounded builder lane {node["id"]}')
        require(node['worktree'] and node['branch'] and node['task_name'], f'incomplete dispatch {node["id"]}')
        require(node['validation'], f'no validation for {node["id"]}')

for key in ['hard_edges', 'preferred_edges']:
    edges = DATA[key]
    pairs = [(edge['before'], edge['after']) for edge in edges]
    require(len(pairs) == len(set(pairs)), f'duplicate {key}')
    for edge in edges:
        require(edge['before'] in nodes and edge['after'] in nodes, f'dangling edge {edge}')
        require(edge['before'] != edge['after'] and edge['reason'], f'invalid edge {edge}')
        a, b = nodes[edge['before']], nodes[edge['after']]
        if a['stage'] is not None and b['stage'] is not None:
            require(a['stage'] <= b['stage'], f'stage violates ordering: {edge}')

hard = topological_layers(nodes, DATA['hard_edges'])
combined = topological_layers(nodes, DATA['hard_edges'] + DATA['preferred_edges'])
require(hard == DATA['topological_waves'], 'stored hard waves are stale')
require(combined == DATA['proposed_ordering_waves'], 'stored preferred waves are stale')
assigned = []
for stage in DATA['execution_stages']:
    require(set(stage['lanes']) == {'A', 'B', 'C'}, 'unexpected coding lane')
    for lane, task_ids in stage['lanes'].items():
        require(len(task_ids) <= 1, f'more than one task in lane {lane} at stage {stage["stage"]}')
        for node_id in task_ids:
            require(nodes[node_id]['owner'] == lane and nodes[node_id]['stage'] == stage['stage'], 'stage/owner mismatch')
            assigned.append(node_id)
require(len(assigned) == len(set(assigned)), 'builder scheduled twice')
require(set(assigned) == {n['id'] for n in nodes.values() if n['kind'] == 'builder'}, 'unscheduled builder')
require(DATA['resource_policy']['max_active_builders'] == 3, 'builder ceiling changed')
require(DATA['resource_policy']['external_450_counts'], 'external #450 must occupy a slot')
require(nodes['i450']['owner'] == 'A', '#450 historical lane ownership lost')
require(nodes['i450']['worktree'] == '/home/dawid/code/tila-worktrees/issue-450', 'wrong #450 worktree')
require(nodes['i450']['task_name'] == 'build-450-deploy', 'wrong external worker name')
for issue in EXPECTED_ISSUES:
    paths = {n['worktree'] for n in nodes.values() if n['issue'] == issue and n['kind'] == 'builder'}
    require(len(paths) <= 1, f'issue {issue} split across worktrees')
worktree_issues = {}
for n in nodes.values():
    if n['kind'] == 'builder':
        key = ('issue', n['issue']) if n['issue'] else ('pr', n['pr'])
        prior = worktree_issues.setdefault(n['worktree'], key)
        require(prior == key, f'worktree reused for different issues: {n["worktree"]}')
require({entry['node'] for entry in DATA['progress_ledger']} == set(nodes), 'ledger coverage')
require(len(DATA['progress_ledger']) == len(nodes), 'duplicate ledger rows')
require(nodes['i261']['kind'] == 'recurring' and nodes['i261']['state'] == 'ongoing', 'dashboard closure attempted')
require(not any(e['before'] == 'i261' for e in DATA['hard_edges']), 'ongoing dashboard blocks finite backlog')

require(all(nodes[n]['conditional'] for n in ['g-release-election', 'release-rehearsal', 'release-publish']), 'release must be optional')
require(any(u.get('pr') == 451 and u.get('source') for u in DATA['execution_updates']), 'missing external PR451 update')

# Snapshot identity is immutable; execution states are deliberately dynamic.
require(all(item['state'] == 'OPEN' for item in inventory), 'snapshot states were overwritten by live progress')
allowed_states = {
    'planned', 'awaiting-review', 'ready', 'implementing', 'in-review',
    'external-in-progress', 'blocked', 'missing-live-prerequisites',
    'not-authorized', 'not-elected', 'elected', 'queued', 'merged',
    'completed', 'closed', 'ongoing', 'not-needed', 'cancelled',
}
terminal = {'merged', 'completed', 'closed'}
ledger = {entry['node']: entry for entry in DATA['progress_ledger']}
for node in nodes.values():
    node_id = node['id']
    require(node['state'] in allowed_states, f'unknown execution state: {node_id}')
    require(ledger[node_id]['state'] == node['state'], f'ledger state differs: {node_id}')
    evidence = node['completion_evidence']
    if node['state'] in terminal:
        require(evidence, f'completed node lacks evidence: {node_id}')
        require(all(isinstance(e, dict) and e.get('source') for e in evidence), f'unsourced completion: {node_id}')
    merges = [e for e in evidence if isinstance(e, dict) and e.get('kind') == 'merge']
    if node['state'] == 'merged' or (node['state'] in terminal and node['pr'] is not None):
        require(merges, f'merged PR lacks independent merge evidence: {node_id}')
    for e in merges:
        require(e.get('pr') and e.get('github_state') == 'MERGED', f'missing GitHub merge state: {node_id}')
        require(re.fullmatch(r'[0-9a-f]{40}', e.get('head_sha', '')), f'missing immutable head SHA: {node_id}')
        require(re.fullmatch(r'[0-9a-f]{40}', e.get('merge_sha', '')), f'missing immutable merge SHA: {node_id}')
        require(e.get('main_ref') and e.get('main_ancestry_verified') is True and e.get('verified_by') and e.get('source'), f'missing independent target-history evidence: {node_id}')
    if node['state'] == 'closed':
        require(ledger[node_id].get('closure') != 'not-closed', f'closed node lacks closure record: {node_id}')

for edge in DATA['hard_edges']:
    if nodes[edge['after']]['state'] in terminal:
        require(nodes[edge['before']]['state'] in terminal, f'completed task has unfinished hard prerequisite: {edge["before"]} -> {edge["after"]}')

release_active = {n['id'] for n in nodes.values() if n['kind'] == 'release-builder' and n['state'] == 'implementing'}
require(len(release_active) <= DATA['resource_policy']['optional_release_workers'], 'release worker ceiling exceeded')
require(release_active == set(DATA['execution_state_policy'].get('current_active_release_workers', [])), 'release dispatch ledger is stale')
active = {n['id'] for n in nodes.values() if n['kind'] == 'builder' and n['state'] in {'implementing', 'external-in-progress'}}
require(len(active) <= DATA['resource_policy']['max_active_builders'], 'active coding ceiling exceeded')
require(len({nodes[n]['owner'] for n in active}) == len(active), 'two active builders share one lane')
require(active == set(DATA['execution_state_policy']['current_active_builders']), 'active dispatch ledger is stale')
if DATA['review_status'].startswith('approved'):
    require(nodes['g-review']['state'] in terminal, 'approved dispatch without completed lead gate')
    require(any(e.get('kind') == 'review' and e.get('reviewer') and e.get('result') == 'approved' for e in nodes['g-review']['completion_evidence']), 'missing lead approval evidence')
if DATA['release_scope']['elected']:
    election = nodes['g-release-election']
    require(election['state'] in terminal | {'elected'}, 'release elected without gate decision')
    require(any(e.get('kind') == 'release-election' and e.get('source') and e.get('reviewer') for e in election['completion_evidence']), 'missing release election evidence')
    selected = DATA['release_scope']['selected_nodes']
    require(selected and set(selected) <= set(nodes), 'release needs a valid selected scope')
    require(all(not nodes[n]['conditional'] and nodes[n]['kind'] != 'recurring' for n in selected), 'invalid release scope')
if nodes['release-rehearsal']['state'] not in {'not-elected', 'planned', 'blocked'}:
    require(DATA['release_scope']['elected'], 'release work without election')
    for selected in DATA['release_scope']['selected_nodes']:
        require(nodes[selected]['state'] in terminal, f'unfinished release scope: {selected}')
        require(any(e['before'] == selected and e['after'] == 'release-rehearsal' for e in DATA['hard_edges']), f'missing elected scope edge: {selected}')
if DATA['release_scope']['production_activation_authorized']:
    authorization = nodes['g-production-authorization']
    require(authorization['state'] in terminal, 'production scope without completed authorization gate')
    require(any(e.get('kind') == 'authorization' and e.get('source') and e.get('operator') and e.get('target') and e.get('scope') for e in authorization['completion_evidence']), 'missing explicit production authorization evidence')
if nodes['g307-activation']['state'] in {'implementing', 'completed', 'closed'}:
    require(DATA['release_scope']['production_activation_authorized'], 'production activity without explicit authorization')

# Native relations retain both outstanding gates and satisfied closed dependencies.
by_issue = {i['number']: i for i in inventory if i['kind'] == 'issue'}
require({i['number'] for i in by_issue[308]['native_blocked_by'] if i['state'] == 'open'} == {283, 307}, 'lost native live blockers')
require({i['number'] for i in by_issue[292]['native_subissues'] if i['state'] == 'open'} == {307, 308, 448, 449}, 'lost native open children')
require(any(d['number'] == 434 and d['merged'] for d in DATA['closed_dependencies']), 'delivered #307 rehearsal not recorded')
print(f'VALID: {len(EXPECTED_ISSUES)} issues + {len(EXPECTED_PRS)} snapshot PRs; PR451 execution update')
print(f'{len(nodes)} nodes; {len(DATA["hard_edges"])} hard and {len(DATA["preferred_edges"])} preferred edges; both DAGs acyclic')
print(f'{len(hard)} hard topological waves; three-lane stages, worktree isolation, evidence anchors and ledger coverage verified')
print('No application tests or live gates were run by this validator.')
