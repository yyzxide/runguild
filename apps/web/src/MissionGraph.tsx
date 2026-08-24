import {
  Background,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import { Bot, Check, Clock3, LockKeyhole } from 'lucide-react'

import type { MissionTask } from './data'

type TaskNodeData = {
  readonly task: MissionTask
}

type TaskNode = Node<TaskNodeData, 'task'>

const statusIcon = {
  verified: Check,
  running: Bot,
  waiting: Clock3,
  queued: LockKeyhole,
}

function TaskNodeCard({ data, selected }: NodeProps<TaskNode>) {
  const task = data.task
  const StatusIcon = statusIcon[task.status]
  return (
    <article className={`task-node task-node--${task.status}${selected ? ' is-selected' : ''}`}>
      <Handle type="target" position={Position.Left} className="task-node__handle" />
      <div className="task-node__topline">
        <span className="task-node__key">{task.key}</span>
        <span className="task-node__role">{task.role}</span>
      </div>
      <h3>{task.title}</h3>
      <div className="task-node__status">
        <span className="task-node__status-icon"><StatusIcon size={13} strokeWidth={2.2} /></span>
        <span>{task.statusLabel}</span>
      </div>
      <div className="task-node__agent">
        <span>{task.agent.slice(0, 1)}</span>
        <strong>{task.agent}</strong>
        <small>{task.duration}</small>
      </div>
      <Handle type="source" position={Position.Right} className="task-node__handle" />
    </article>
  )
}

const nodeTypes = { task: TaskNodeCard }

export function MissionGraph({
  tasks,
  selectedTaskId,
  onSelectTask,
}: {
  readonly tasks: readonly MissionTask[]
  readonly selectedTaskId: string
  readonly onSelectTask: (taskId: string) => void
}) {
  const taskById = new Map(tasks.map((task) => [task.id, task]))
  const depthCache = new Map<string, number>()
  const depthOf = (task: MissionTask, visiting = new Set<string>()): number => {
    const cached = depthCache.get(task.id)
    if (cached !== undefined) return cached
    if (visiting.has(task.id)) return 0
    visiting.add(task.id)
    const depth = task.dependsOn.reduce((maximum, parentId) => {
      const parent = taskById.get(parentId)
      return parent ? Math.max(maximum, depthOf(parent, visiting) + 1) : maximum
    }, 0)
    depthCache.set(task.id, depth)
    return depth
  }
  const layers = new Map<number, MissionTask[]>()
  for (const task of tasks) {
    const depth = depthOf(task)
    layers.set(depth, [...(layers.get(depth) ?? []), task])
  }
  const nodes: TaskNode[] = tasks.map((task) => {
    const depth = depthOf(task)
    const siblings = layers.get(depth) ?? [task]
    const index = siblings.findIndex((item) => item.id === task.id)
    return {
      id: task.id,
      type: 'task',
      position: { x: 22 + depth * 310, y: 42 + index * 202 },
      selected: selectedTaskId === task.id,
      data: { task },
    }
  })
  const edges: Edge[] = tasks.flatMap((task) => task.dependsOn.map((parentId) => {
    const parent = taskById.get(parentId)
    const verified = parent?.status === 'verified'
    const active = parent?.status === 'running'
    return {
      id: parentId + '-' + task.id,
      source: parentId,
      target: task.id,
      className: `edge ${verified ? 'edge--verified' : active ? 'edge--active' : 'edge--pending'}`,
      animated: active,
    }
  }))

  return (
    <div className="mission-graph" aria-label="Mission 任务依赖图">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        minZoom={0.72}
        maxZoom={1.2}
        fitView
        fitViewOptions={{ padding: 0.11 }}
        onNodeClick={(_, node) => onSelectTask(node.id)}
        selectNodesOnDrag={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={22} size={1} color="#d7dce5" />
      </ReactFlow>
      <div className="graph-legend" aria-hidden="true">
        <span><i className="legend-dot legend-dot--verified" /> 已验证</span>
        <span><i className="legend-dot legend-dot--active" /> 执行中</span>
        <span><i className="legend-dot legend-dot--waiting" /> 等待中</span>
      </div>
    </div>
  )
}
