import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Feather } from '@expo/vector-icons';
import {
  ActivityIndicator,
  Image,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { MobileRuntimeState, RuntimeCommand, RuntimeHost, RuntimeProject, RuntimeTask, RuntimeTaskPage } from './protocol';
import { hostScopedId } from './host-scope';
import { invalidateTaskCache, loadCachedTaskPage, peekTaskCache } from './task-cache';
import { fetchTaskPage } from './task-pages';

type Colors = {
  background: string;
  surface: string;
  elevated: string;
  border: string;
  text: string;
  secondary: string;
  muted: string;
  accent: string;
  accentText: string;
  danger: string;
};

type Props = {
  mode: 'projects' | 'kanban';
  openBoard: () => void;
  runtime: MobileRuntimeState;
  colors: Colors;
  desktopWeb: boolean;
  refreshVersion: number;
  sendCommand: (command: RuntimeCommand) => Promise<unknown>;
  notify: (message: string) => void;
};

const STATUSES = [
  ['pending', 'To do'],
  ['in_progress', 'In progress'],
  ['in_testing', 'Testing'],
  ['completed', 'Done'],
] as const;
const ICONS = ['📁', '🚀', '⚡', '🧠', '🛠️', '🎨', '📱', '🌐'];
const COLORS = ['#007ACC', '#7C3AED', '#DB2777', '#DC2626', '#D97706', '#059669', '#0891B2'];

function hostForProject(project: RuntimeProject, hosts: RuntimeHost[]) {
  return hosts.find((host) => host.runtimeId === project.hostRuntimeId);
}

function projectIcon(project: RuntimeProject) {
  if (project.iconDataUrl) return <Image source={{ uri: project.iconDataUrl }} style={s.projectImage} />;
  if (project.icon?.startsWith('emoji:')) return <Text style={s.projectEmoji}>{project.icon.slice(6)}</Text>;
  const glyph = project.icon?.replace(/^(lucide|feather):/, '');
  if (glyph && glyph in Feather.glyphMap) return <Feather name={glyph as keyof typeof Feather.glyphMap} size={22} color="#FFF" />;
  return <Text style={s.projectInitial}>{project.name.trim().slice(0, 1).toUpperCase() || 'P'}</Text>;
}

function Field({ label, value, onChangeText, placeholder, multiline = false, testID, styles }: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  multiline?: boolean;
  testID?: string;
  styles: ReturnType<typeof themed>;
}) {
  return <View style={styles.field}><Text style={styles.fieldLabel}>{label}</Text><TextInput testID={testID} value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor={styles.placeholder.color} multiline={multiline} style={[styles.input, multiline && styles.textarea]} /></View>;
}

export function ProjectsKanbanScreen({ mode, runtime, colors, desktopWeb, refreshVersion, sendCommand, notify, openBoard }: Props) {
  const styles = useMemo(() => themed(colors), [colors]);
  const hosts = runtime.hosts?.filter((host) => host.phase !== 'unpaired') || [];
  const [hostFilter, setHostFilter] = useState('all');
  const [selection, setSelection] = useState('');
  const [query, setQuery] = useState('');
  const [taskQuery, setTaskQuery] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [taskState, setTaskState] = useState({ identity: '', countsScope: '', page: { tasks: [] } as RuntimeTaskPage, resolved: false, loading: false, error: '' });
  const [pickerQuery, setPickerQuery] = useState('');
  const [picker, setPicker] = useState<'project' | 'host' | null>(null);
  const [detail, setDetail] = useState<RuntimeProject | null>(null);
  const [projectOpen, setProjectOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<RuntimeProject | null>(null);
  const [editorHostId, setEditorHostId] = useState('');
  const [taskOpen, setTaskOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<RuntimeTask | null>(null);
  const [taskContext, setTaskContext] = useState<RuntimeProject | null>(null);
  const [movingTask, setMovingTask] = useState<RuntimeTask | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [aiAvailable, setAiAvailable] = useState(false);
  const [status, setStatus] = useState<RuntimeTask['status']>('in_progress');
  const taskLoadId = useRef(0);
  const deferredProject = useRef<{ project: RuntimeProject | null; host: RuntimeHost } | null>(null);

  const projects = runtime.projects.filter((item) => hosts.some((host) => host.runtimeId === item.hostRuntimeId));
  const project = projects.find((item) => projectKey(item) === selection) || projects[0] || null;
  const cursor = cursors[cursors.length - 1];
  const pageScope = JSON.stringify([desktopWeb ? null : status, searchQuery, cursor]);
  const boardIdentity = JSON.stringify([mode, project ? projectKey(project) : '', pageScope]);
  const currentBoard = useRef(boardIdentity);
  currentBoard.current = boardIdentity;
  const boardHost = project ? hostForProject(project, hosts) : undefined;
  const boardCapabilities = new Set(boardHost?.capabilities || []);
  const canListTasks = boardCapabilities.has('tasks.list');
  const host = hosts.find((candidate) => candidate.runtimeId === editorHostId);
  const capabilities = new Set(host?.capabilities || []);
  const hostRuntimeId = boardHost?.runtimeId;
  const selectedProjectId = project?.projectId;
  const countsScope = JSON.stringify([project ? projectKey(project) : '', searchQuery]);
  const pageMatches = taskState.identity === boardIdentity;
  const rememberedPage = hostRuntimeId && selectedProjectId ? peekTaskCache(hostRuntimeId, selectedProjectId, pageScope)?.page : undefined;
  const resolvedPage = pageMatches && taskState.resolved ? taskState.page : rememberedPage;
  const page = resolvedPage || { tasks: [], counts: taskState.countsScope === countsScope ? taskState.page.counts : undefined };
  const tasks = page.tasks;
  const counts = page.counts || Object.fromEntries(STATUSES.map(([value]) => [value, tasks.filter((task) => task.status === value).length]));
  const loadingTasks = !pageMatches || taskState.loading || (canListTasks && !taskState.resolved && !taskState.error);
  const waitingForPage = loadingTasks && !resolvedPage;
  const taskError = pageMatches ? taskState.error : '';
  const searchable = boardCapabilities.has('tasks.search');
  const online = boardHost?.phase === 'online';
  const editorOnline = host?.phase === 'online';
  const visibleProjects = projects.filter((item) => (hostFilter === 'all' || item.hostRuntimeId === hostFilter) && matchesProject(item, query));
  const visibleTasks = tasks;
  const changeStatus = (value: RuntimeTask['status']) => { setCursors([null]); setStatus(value); };
  const selectProject = (item: RuntimeProject) => { setSelection(projectKey(item)); setTaskQuery(''); setSearchQuery(''); setCursors([null]); setStatus('in_progress'); };
  useEffect(() => {
    if (taskQuery.trim() === searchQuery) return;
    const timer = setTimeout(() => { setSearchQuery(taskQuery.trim()); setCursors([null]); }, 250);
    return () => clearTimeout(timer);
  }, [taskQuery, searchQuery]);
  useEffect(() => { setCursors([null]); }, [desktopWeb, hostRuntimeId, selectedProjectId]);
  const editProject = (item: RuntimeProject | null, owner: RuntimeHost, dismissFirst = false) => {
    if (dismissFirst && Platform.OS === 'ios') { deferredProject.current = { project: item, host: owner }; return; }
    setEditingProject(item); setEditorHostId(owner.runtimeId); setProjectOpen(true);
  };
  const openDeferredProject = () => {
    const pending = deferredProject.current;
    deferredProject.current = null;
    if (pending) editProject(pending.project, pending.host);
  };
  const addProject = () => {
    const available = hosts.filter((owner) => owner.phase === 'online' && owner.capabilities.some((capability) => ['project.create', 'project.register'].includes(capability)));
    if (available.length === 1) editProject(null, available[0]);
    else setPicker('host');
  };
  const editTask = (task: RuntimeTask | null) => { setTaskContext(project); setEditingTask(task); setTaskOpen(true); };
  const taskOwner = taskContext ? hostForProject(taskContext, hosts) : undefined;
  const taskWritable = taskOwner?.phase === 'online' && taskOwner.capabilities.includes(editingTask ? 'task.update' : 'task.create') && projects.some((item) => projectKey(item) === projectKey(taskContext!));

  useEffect(() => {
    if (hostFilter !== 'all' && !hosts.some((owner) => owner.runtimeId === hostFilter)) setHostFilter('all');
  }, [hostFilter, hosts]);
  useEffect(() => {
    let active = true;
    setAiAvailable(false);
    if (!projectOpen || !editorOnline || !capabilities.has('project.icon.generate') || !host) return;
    void sendCommand({ type: 'project.icon.availability', runtimeId: host.runtimeId }).then((result) => {
      if (active) setAiAvailable((result as { available?: boolean })?.available === true);
    }).catch(() => {});
    return () => { active = false; };
  }, [projectOpen, editorOnline, host?.runtimeId, host?.capabilities, sendCommand]);

  const loadTasks = useCallback(async (force = false) => {
    if (currentBoard.current !== boardIdentity) return;
    const loadId = ++taskLoadId.current;
    const isCurrent = () => loadId === taskLoadId.current && currentBoard.current === boardIdentity;
    const canLoad = Boolean(hostRuntimeId && selectedProjectId && canListTasks);
    const cachedPage = hostRuntimeId && selectedProjectId ? peekTaskCache(hostRuntimeId, selectedProjectId, pageScope)?.page : undefined;
    setTaskState((previous) => ({
      identity: boardIdentity, countsScope, loading: canLoad, error: '',
      resolved: canLoad && (previous.identity === boardIdentity ? previous.resolved : Boolean(cachedPage)),
      page: !canLoad ? { tasks: [] } : previous.identity === boardIdentity ? previous.page
        : cachedPage || { tasks: [], counts: previous.countsScope === countsScope ? previous.page.counts : undefined },
    }));
    if (!hostRuntimeId || !selectedProjectId || !canListTasks) return;
    const setPage = (page: RuntimeTaskPage) => setTaskState((previous) => ({ ...previous, page, resolved: true }));
    try {
      if (online && force) await invalidateTaskCache(hostRuntimeId, selectedProjectId);
      if (!isCurrent()) return;
      const loaded = await loadCachedTaskPage({
        hostRuntimeId, projectId: selectedProjectId, force: online && force,
        isCurrent,
        onCached: setPage,
        scope: pageScope,
        fetchTasks: async () => {
          if (!online) throw new Error('This host is offline. Showing saved tasks.');
          return fetchTaskPage(sendCommand, {
            runtimeId: hostRuntimeId, projectId: selectedProjectId,
            status: desktopWeb ? undefined : status, query: searchQuery, cursor, searchable,
          }, isCurrent);
        },
      });
      if (loaded && isCurrent()) setPage(loaded);
    } catch {
      if (isCurrent()) setTaskState((previous) => ({ ...previous, error: online ? 'Could not load tasks. Try again.' : 'This host is offline. Showing saved tasks.' }));
    } finally {
      if (isCurrent()) setTaskState((previous) => ({ ...previous, loading: false }));
    }
  }, [boardIdentity, countsScope, canListTasks, hostRuntimeId, online, selectedProjectId, sendCommand, pageScope, cursor, desktopWeb, searchQuery, status, searchable]);

  useEffect(() => { if (mode === 'kanban') void loadTasks(); return () => { taskLoadId.current += 1; }; }, [loadTasks, mode, refreshVersion]);

  const run = async (action: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try { await action(); } catch { notify('Could not save changes. Please try again.'); } finally { busyRef.current = false; setBusy(false); }
  };
  const card = (task: RuntimeTask) => <TaskCard key={task.id} task={task} styles={styles} colors={colors} open={() => editTask(task)} move={online && boardCapabilities.has('task.update') && !busy ? () => { setTaskContext(project); setMovingTask(task); } : undefined} />;

  return <View testID={`${mode}-screen`} style={[styles.screen, desktopWeb && styles.screenDesktop]}>
    <View style={styles.header}>
      <View style={styles.grow}><Text style={styles.title}>{mode === 'projects' ? 'Projects' : 'Kanban'}</Text><Text style={styles.subtitle}>{mode === 'projects' ? `${projects.length} projects across ${hosts.length} host${hosts.length === 1 ? '' : 's'}` : waitingForPage && !page.counts ? 'Loading board…' : taskError && !tasks.length ? 'Board unavailable' : !page.counts ? `${tasks.length} tasks on this page` : `${counts.pending + counts.in_progress + counts.in_testing} open · ${counts.completed} done${searchQuery ? ' matching' : ''}`}</Text></View>
      <Pressable testID={mode === 'projects' ? 'add-project' : 'add-task'} accessibilityRole="button" accessibilityLabel={mode === 'projects' ? 'Add project' : 'Add task'} disabled={mode === 'projects' ? !hosts.some((owner) => owner.phase === 'online' && owner.capabilities.some((capability) => ['project.create', 'project.register'].includes(capability))) : !online || !selectedProjectId || !boardCapabilities.has('task.create')} onPress={() => mode === 'projects' ? addProject() : editTask(null)} style={styles.addButton}><Feather name="plus" size={23} color={colors.accentText} /></Pressable>
    </View>
    {mode === 'projects' ? <>
      <SearchField label="Search projects" placeholder="Search projects or hosts" value={query} change={setQuery} styles={styles} colors={colors} />
      <ScrollView horizontal keyboardDismissMode="on-drag" style={styles.hostStrip} showsHorizontalScrollIndicator={false} contentContainerStyle={styles.hosts}>
        {[{ runtimeId: 'all', name: 'All hosts' }, ...hosts].map((owner) => <Pressable key={owner.runtimeId} accessibilityRole="radio" accessibilityLabel={owner.name} accessibilityState={{ checked: hostFilter === owner.runtimeId }} {...(Platform.OS === 'web' ? { 'aria-checked': hostFilter === owner.runtimeId } : {})} onPress={() => setHostFilter(owner.runtimeId)} style={[styles.hostChip, hostFilter === owner.runtimeId && styles.hostChipActive]}><Text style={[styles.hostChipText, hostFilter === owner.runtimeId && styles.hostChipTextActive]}>{owner.name}</Text></Pressable>)}
      </ScrollView>
      <ScrollView keyboardDismissMode="on-drag" keyboardShouldPersistTaps="handled" contentContainerStyle={styles.projectGrid}>
        <ProjectRows projects={visibleProjects} hosts={hosts} styles={styles} colors={colors} choose={setDetail} />
        {!visibleProjects.length ? <Empty title={query || hostFilter !== 'all' ? 'No matching projects' : 'No projects yet'} copy={query ? 'Try another project or host name.' : 'Add a project from a connected host.'} styles={styles} /> : null}
      </ScrollView>
    </> : <>
      <Pressable accessibilityRole="button" accessibilityLabel="Choose project for Kanban" onPress={() => { setPickerQuery(''); setPicker('project'); }} style={styles.projectSelect}>
        {project ? <View style={[styles.projectIcon, { backgroundColor: project.color || colors.accent }]}>{projectIcon(project)}</View> : <Feather name="folder" size={25} color={colors.secondary} />}
        <View style={styles.grow}><Text style={styles.projectName} numberOfLines={1}>{project?.name || 'Choose a project'}</Text><Text style={styles.projectPath} numberOfLines={1}>{boardHost ? `${boardHost.name} · ${online ? 'Online' : 'Offline'}` : 'Search all hosts'}</Text></View><Feather name="chevron-down" size={18} color={colors.secondary} />
      </Pressable>
      <SearchField label="Search tasks" placeholder="Search tasks in this project" value={taskQuery} change={setTaskQuery} styles={styles} colors={colors} />
      {!desktopWeb ? <View accessibilityRole="tablist" style={styles.statusTabs}>{STATUSES.map(([value, label]) => <Pressable key={value} testID={`kanban-status-${value}`} accessibilityRole="tab" accessibilityLabel={label} accessibilityState={{ selected: status === value }} {...(Platform.OS === 'web' ? { 'aria-selected': status === value } : {})} onPress={() => changeStatus(value)} style={[styles.statusTab, value === status && styles.statusTabActive]}><Text style={[styles.statusCount, value === status && styles.statusActiveText]}>{page.counts ? counts[value] : '—'}</Text><Text style={[styles.statusLabel, value === status && styles.statusActiveText]}>{label}</Text></Pressable>)}</View> : null}
      {taskError || !online ? <View style={styles.notice}><Text style={styles.noticeText}>{taskError || 'This host is offline. Showing saved tasks.'}</Text>{online ? <Pressable accessibilityRole="button" onPress={() => void loadTasks(true)} style={styles.retryButton}><Text style={styles.moveText}>Try again</Text></Pressable> : null}</View> : null}
      {!project ? <Empty title="Choose a project" copy="Search projects across your connected hosts." styles={styles} /> : !canListTasks ? <Empty title="Tasks unavailable" copy="Update this host to manage its tasks from Mobile." styles={styles} /> : waitingForPage ? <ActivityIndicator accessibilityLabel="Loading tasks" color={colors.accent} style={s.loader} /> : desktopWeb ? <ScrollView key={boardIdentity} horizontal keyboardDismissMode="on-drag" contentContainerStyle={styles.boardDesktop}>{STATUSES.map(([value, label]) => <View key={value} style={styles.column}><View style={styles.columnHeader}><Text style={styles.columnTitle}>{label}</Text><Text style={styles.count}>{page.counts ? counts[value] : '—'}</Text></View><ScrollView keyboardDismissMode="on-drag" keyboardShouldPersistTaps="handled">{visibleTasks.filter((task) => task.status === value).map(card)}</ScrollView></View>)}</ScrollView> : <ScrollView key={boardIdentity} keyboardDismissMode="on-drag" keyboardShouldPersistTaps="handled" contentContainerStyle={styles.boardMobile}>
        <View style={styles.boardToolbar}><Text style={styles.boardSummary}>{taskQuery && page.counts ? `${counts[status]} matches in ` : ''}{STATUSES.find(([value]) => value === status)?.[1]}</Text><Pressable accessibilityRole="button" accessibilityLabel="Refresh tasks" disabled={!online || loadingTasks} onPress={() => void loadTasks(true)} style={styles.iconButton}><Feather name="refresh-cw" size={16} color={colors.secondary} /></Pressable></View>
        {visibleTasks.filter((task) => task.status === status).map(card)}
        {!waitingForPage && !taskError && !visibleTasks.some((task) => task.status === status) ? <Empty title={taskQuery ? 'No matching tasks' : 'No tasks in this stage'} copy={taskQuery ? 'Try another title or label, or switch stages.' : 'Add a task or move one from another stage.'} styles={styles} /> : null}
        {online && boardCapabilities.has('task.create') ? <Pressable accessibilityRole="button" accessibilityLabel="Add task to this stage" onPress={() => editTask(null)} style={styles.inlineAdd}><Feather name="plus" size={17} color={colors.secondary} /><Text style={styles.boardSummary}>Add task</Text></Pressable> : null}
      </ScrollView>}
      {project && canListTasks ? <View style={styles.pagination}>
        <Pressable accessibilityRole="button" accessibilityLabel="Previous task page" disabled={loadingTasks || cursors.length === 1} onPress={() => setCursors((values) => values.slice(0, -1))} style={[styles.secondaryButton, (loadingTasks || cursors.length === 1) && styles.disabled]}><Text style={styles.secondaryButtonText}>Previous</Text></Pressable>
        <Text style={styles.boardSummary}>Page {cursors.length}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Next task page" disabled={loadingTasks || !page.nextCursor} onPress={() => { if (page.nextCursor) setCursors((values) => [...values, page.nextCursor!]); }} style={[styles.secondaryButton, (loadingTasks || !page.nextCursor) && styles.disabled]}><Text style={styles.secondaryButtonText}>Next</Text></Pressable>
      </View> : null}
    </>}
    <PickerSheet onDismiss={openDeferredProject} open={picker !== null} close={() => setPicker(null)} title={picker === 'host' ? 'Choose a host' : 'Choose a project'} styles={styles} colors={colors}>
      {picker === 'project' ? <><SearchField label="Find a project" placeholder="Search all projects and hosts" value={pickerQuery} change={setPickerQuery} styles={styles} colors={colors} /><ScrollView keyboardDismissMode="on-drag" keyboardShouldPersistTaps="handled" contentContainerStyle={styles.projectGrid}><ProjectRows projects={projects.filter((item) => matchesProject(item, pickerQuery))} hosts={hosts} styles={styles} colors={colors} choose={(item) => { selectProject(item); setPicker(null); }} picking />{!projects.some((item) => matchesProject(item, pickerQuery)) ? <Empty title="No matching projects" copy="Try another project or host name." styles={styles} /> : null}</ScrollView></> : hosts.map((owner) => <Pressable key={owner.runtimeId} accessibilityRole="button" disabled={owner.phase !== 'online' || !owner.capabilities.some((capability) => ['project.create', 'project.register'].includes(capability))} onPress={() => { editProject(null, owner, true); setPicker(null); }} style={styles.hostChoice}><Feather name={owner.kind === 'cloud' ? 'cloud' : 'monitor'} color={colors.secondary} size={20} /><Text style={styles.projectName}>{owner.name}</Text><Text style={styles.projectPath}>{owner.phase === 'online' ? 'Online' : 'Offline'}</Text></Pressable>)}
    </PickerSheet>
    <PickerSheet onDismiss={openDeferredProject} open={detail !== null} close={() => setDetail(null)} title="Project" styles={styles} colors={colors}>
      {detail ? <View style={styles.detailBody}><Text style={styles.modalTitle}>{detail.name}</Text><Text style={styles.subtitle}>{detail.hostName || hostForProject(detail, hosts)?.name}</Text><Text selectable style={styles.detailPath}>{detail.hostPath || detail.path}</Text><View style={styles.modalActions}><Pressable accessibilityRole="button" accessibilityLabel="Edit project" disabled={hostForProject(detail, hosts)?.phase !== 'online'} onPress={() => { const owner = hostForProject(detail, hosts); if (owner) { editProject(detail, owner, true); setDetail(null); } }} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>Edit project</Text></Pressable><Pressable accessibilityRole="button" accessibilityLabel="Open board" onPress={() => { selectProject(detail); setDetail(null); openBoard(); }} style={styles.primaryButton}><Text style={styles.primaryButtonText}>Open board</Text></Pressable></View></View> : null}
    </PickerSheet>
    <PickerSheet open={movingTask !== null} close={() => setMovingTask(null)} title="Move task" styles={styles} colors={colors}>
      <Text style={styles.moveTitle}>{movingTask?.title}</Text>{STATUSES.map(([value, label]) => <Pressable key={value} accessibilityRole="radio" accessibilityLabel={label} accessibilityState={{ checked: movingTask?.status === value }} {...(Platform.OS === 'web' ? { 'aria-checked': movingTask?.status === value } : {})} disabled={busy || taskOwner?.phase !== 'online' || !taskOwner.capabilities.includes('task.update')} onPress={() => void run(async () => {
        if (!taskContext?.projectId || !taskOwner || !movingTask) return;
        await sendCommand({ type: 'task.update', runtimeId: taskOwner.runtimeId, payload: { projectId: taskContext.projectId, id: movingTask.id, status: value, requestId: `mobile-task-move-${Date.now()}` } });
        setMovingTask(null); await loadTasks(true);
      })} style={styles.hostChoice}><Text style={styles.projectName}>{label}</Text>{movingTask?.status === value ? <Feather name="check" color={colors.accent} size={18} /> : null}</Pressable>)}
    </PickerSheet>
    <ProjectEditor open={projectOpen} close={() => setProjectOpen(false)} project={editingProject} projects={projects.filter((item) => item.hostRuntimeId === host?.runtimeId)} host={host} roots={runtime.projectRoots.filter((root) => root.hostRuntimeId === host?.runtimeId)} capabilities={capabilities} aiAvailable={aiAvailable} colors={colors} styles={styles} busy={busy || !editorOnline} sendCommand={sendCommand} generateIcon={(description) => void run(async () => {
      if (!host || !editingProject?.projectId || !editorOnline) return;
      const result = await sendCommand({ type: 'project.icon.generate', runtimeId: host.runtimeId, payload: { projectId: editingProject.projectId, description, jobId: `mobile-icon-${Date.now()}` } }) as { success?: boolean; error?: string };
      if (result?.success === false) throw new Error(result.error || 'Could not start icon generation');
      notify('Codex is generating the icon in the background');
    })} save={(values) => void run(async () => {
      if (!host || !editorOnline) return;
      const requestId = `mobile-project-${Date.now()}`;
      if (editingProject?.projectId) await sendCommand({ type: 'project.update', runtimeId: host.runtimeId, payload: { projectId: editingProject.projectId, displayName: values.name, ...(host.kind === 'desktop' ? { projectPath: values.path } : {}), color: values.color, icon: values.icon, requestId } });
      else if (host.kind === 'cloud') await sendCommand({ type: values.url ? 'project.clone' : 'project.register', runtimeId: host.runtimeId, payload: { rootId: values.rootId, ...(values.url ? { url: values.url } : {}), relativePath: values.path, requestId } });
      else await sendCommand({ type: 'project.create', runtimeId: host.runtimeId, payload: { name: values.name, projectPath: values.path, color: values.color, icon: values.icon, requestId } });
      setProjectOpen(false);
    })} remove={editingProject?.projectId && editorOnline && capabilities.has('project.unregister') ? () => void run(async () => { await sendCommand({ type: 'project.unregister', runtimeId: host!.runtimeId, payload: { projectId: editingProject.projectId, requestId: `mobile-project-remove-${Date.now()}` } }); setProjectOpen(false); }) : undefined} />
    <TaskEditor open={taskOpen} close={() => setTaskOpen(false)} task={editingTask} defaultStatus={status} colors={colors} styles={styles} busy={busy || !taskWritable} save={(values) => void run(async () => {
      if (!taskOwner || !taskContext?.projectId || !taskWritable) return;
      await sendCommand({ type: editingTask ? 'task.update' : 'task.create', runtimeId: taskOwner.runtimeId, payload: { projectId: taskContext.projectId, ...(editingTask ? { id: editingTask.id } : {}), ...values, requestId: `mobile-task-${Date.now()}` } });
      setTaskOpen(false); changeStatus(values.status); await loadTasks(true);
    })} remove={editingTask && taskWritable && taskOwner?.capabilities.includes('task.delete') ? () => void run(async () => { await sendCommand({ type: 'task.delete', runtimeId: taskOwner.runtimeId, payload: { projectId: taskContext!.projectId, id: editingTask.id, requestId: `mobile-task-remove-${Date.now()}` } }); setTaskOpen(false); await loadTasks(true); }) : undefined} />
  </View>;
}

function projectKey(project: RuntimeProject) { return hostScopedId(project.hostRuntimeId || '', project.projectId || project.path); }
function matchesProject(project: RuntimeProject, query: string) { return `${project.name} ${project.hostName || ''} ${project.hostPath || project.path}`.toLowerCase().includes(query.trim().toLowerCase()); }
function SearchField({ label, placeholder, value, change, styles, colors }: { label: string; placeholder: string; value: string; change: (value: string) => void; styles: ReturnType<typeof themed>; colors: Colors }) {
  return <View style={styles.search}><Feather name="search" size={18} color={colors.secondary} /><TextInput accessibilityLabel={label} placeholder={placeholder} placeholderTextColor={colors.secondary} value={value} onChangeText={change} style={styles.searchInput} autoCorrect={false} clearButtonMode="while-editing" /></View>;
}
function ProjectRows({ projects, hosts, styles, colors, choose, picking = false }: { projects: RuntimeProject[]; hosts: RuntimeHost[]; styles: ReturnType<typeof themed>; colors: Colors; choose: (project: RuntimeProject) => void; picking?: boolean }) {
  return <>{hosts.map((host) => {
    const rows = projects.filter((project) => project.hostRuntimeId === host.runtimeId);
    if (!rows.length) return null;
    return <View key={host.runtimeId}><View style={styles.groupHeading}><Feather name={host.kind === 'cloud' ? 'cloud' : 'monitor'} size={15} color={colors.secondary} /><Text style={styles.groupName}>{host.name} <Text style={styles.count}>{rows.length}</Text></Text><Text style={styles.connection}>{host.phase === 'online' ? 'Online' : 'Offline'}</Text></View>{rows.map((item) => <Pressable key={projectKey(item)} testID={`project-card-${projectKey(item)}`} accessibilityRole="button" accessibilityLabel={`${picking ? 'Choose' : 'Open'} project ${item.name}`} onPress={() => choose(item)} style={({ pressed }) => [styles.projectCard, pressed && styles.pressed]}><View style={[styles.projectIcon, { backgroundColor: item.color || colors.accent }]}>{projectIcon(item)}</View><View style={styles.grow}><Text style={styles.projectName} numberOfLines={1}>{item.name}</Text><Text style={styles.projectPath} numberOfLines={1}>{(item.hostPath || item.path).replace(/[\\/]+$/, '').split(/[\\/]/).slice(-2).join('/')}</Text></View><Feather name="chevron-right" size={17} color={colors.secondary} /></Pressable>)}{host.phase !== 'online' ? <Text style={styles.offlineCopy}>Saved projects · available when this host reconnects</Text> : null}</View>;
  })}</>;
}
function PickerSheet({ open, close, onDismiss, title, styles, colors, children }: { open: boolean; close: () => void; onDismiss?: () => void; title: string; styles: ReturnType<typeof themed>; colors: Colors; children: React.ReactNode }) {
  return <Modal visible={open} transparent animationType="fade" onDismiss={onDismiss} onRequestClose={close}><Pressable accessible={false} accessibilityRole="button" accessibilityLabel={`Close ${title.toLowerCase()}`} onPress={close} style={styles.pickerBackdrop}><Pressable accessible={false} accessibilityRole="none" onPress={() => {}} style={styles.pickerSheet}><View style={styles.pickerHeader}><Text style={styles.pickerTitle}>{title}</Text><Pressable accessibilityRole="button" accessibilityLabel="Close dialog" onPress={close} style={styles.iconButton}><Feather name="x" size={21} color={colors.text} /></Pressable></View>{children}</Pressable></Pressable></Modal>;
}
function Empty({ title, copy, styles }: { title: string; copy: string; styles: ReturnType<typeof themed> }) {
  return <View style={styles.empty}><Text style={styles.emptyTitle}>{title}</Text><Text style={styles.emptyCopy}>{copy}</Text></View>;
}
function TaskCard({ task, styles, colors, open, move }: { task: RuntimeTask; styles: ReturnType<typeof themed>; colors: Colors; open: () => void; move?: () => void }) {
  return <View style={styles.taskCard}><Pressable testID={`task-card-${task.id}`} accessibilityRole="button" accessibilityLabel={`Edit task ${task.title}`} onPress={open}><Text style={styles.taskTitle}>{task.title}</Text>{task.description ? <Text numberOfLines={2} style={styles.taskDescription}>{task.description}</Text> : null}<View style={styles.labels}>{task.labels.slice(0, 4).map((label, index) => <View key={index} style={styles.label}><Text style={styles.labelText}>{typeof label === 'string' ? label : label.text}</Text></View>)}</View></Pressable><View style={styles.taskFooter}><Text style={styles.taskId}>#{task.id}</Text><Pressable accessibilityRole="button" accessibilityLabel={`Move task ${task.title}`} disabled={!move} onPress={move} style={styles.moveButton}><Text style={[styles.moveText, !move && { color: colors.secondary }]}>Move to</Text><Feather name="arrow-right" size={14} color={move ? colors.accent : colors.secondary} /></Pressable></View></View>;
}

type ProjectValues = { name: string; path: string; rootId: string; url: string; color: string; icon: string };
type DirectoryResult = {
  rootId?: string;
  path: string;
  parentPath: string | null;
  directories: Array<{ name: string; path: string }>;
  locations: Array<{ name: string; path?: string; rootId?: string }>;
};

function ProjectEditor({ open, close, project, projects, host, roots, capabilities, aiAvailable, colors, styles, busy, sendCommand, generateIcon, save, remove }: {
  open: boolean;
  close: () => void;
  project: RuntimeProject | null;
  projects: RuntimeProject[];
  host?: RuntimeHost;
  roots: MobileRuntimeState['projectRoots'];
  capabilities: Set<string>;
  aiAvailable: boolean;
  colors: Colors;
  styles: ReturnType<typeof themed>;
  busy: boolean;
  sendCommand: (command: RuntimeCommand) => Promise<unknown>;
  generateIcon: (description: string) => void;
  save: (values: ProjectValues) => void;
  remove?: () => void;
}) {
  const [values, setValues] = useState<ProjectValues>({ name: '', path: '', rootId: '', url: '', color: COLORS[0], icon: `emoji:${ICONS[0]}` });
  const [iconIdea, setIconIdea] = useState('');
  const [folderOpen, setFolderOpen] = useState(false);
  const [folderQuery, setFolderQuery] = useState('');
  const [folderBusy, setFolderBusy] = useState(false);
  const [folderError, setFolderError] = useState('');
  const [folderResult, setFolderResult] = useState<DirectoryResult | null>(null);
  const defaultRootId = roots[0]?.rootId || '';
  useEffect(() => {
    if (!open) return;
    setValues({ name: project?.name || '', path: project?.hostPath || project?.path || '', rootId: project?.rootId || defaultRootId, url: '', color: project?.color || COLORS[0], icon: project?.icon || `emoji:${ICONS[0]}` });
    setFolderOpen(false);
    setFolderQuery('');
    setFolderError('');
    setFolderResult(null);
  }, [defaultRootId, open, project]);
  const update = (patch: Partial<ProjectValues>) => setValues((current) => ({ ...current, ...patch }));
  const cloudNew = host?.kind === 'cloud' && !project;
  const valid = cloudNew ? Boolean(values.rootId && values.path.trim()) : Boolean(values.name.trim() && values.path.trim());
  const canBrowse = capabilities.has('project.directories.list');
  const recentProjects = host?.kind === 'desktop' ? projects.slice(0, 4) : [];
  const visibleDirectories = (folderResult?.directories || []).filter((directory) => directory.name.toLocaleLowerCase().includes(folderQuery.trim().toLocaleLowerCase()));

  const loadFolders = async ({ path, rootId }: { path?: string; rootId?: string } = {}) => {
    if (!host) return;
    setFolderBusy(true);
    setFolderError('');
    try {
      const selectedRootId = rootId || folderResult?.rootId || values.rootId || roots[0]?.rootId;
      const payload = host.kind === 'cloud'
        ? { rootId: selectedRootId, relativePath: path || '.' }
        : path ? { directoryPath: path } : {};
      const result = await sendCommand({ type: 'project.directories.list', runtimeId: host.runtimeId, payload }) as DirectoryResult;
      setFolderResult(result);
      setFolderQuery('');
    } catch (error) {
      setFolderError(error instanceof Error ? error.message : 'Could not load folders');
    } finally {
      setFolderBusy(false);
    }
  };
  const openFolders = () => {
    setFolderOpen(true);
    void loadFolders(host?.kind === 'cloud' ? { rootId: values.rootId } : values.path ? { path: values.path } : undefined);
  };
  const dismiss = () => folderOpen ? setFolderOpen(false) : close();

  return <Modal visible={open} transparent animationType="fade" onRequestClose={dismiss}>
    <Pressable accessible={false} accessibilityRole="button" accessibilityLabel={folderOpen ? 'Close folder picker' : 'Close project editor'} onPress={dismiss} style={styles.modalBackdrop}>
      <Pressable accessible={false} accessibilityRole="none" onPress={() => {}} testID={folderOpen ? 'project-folder-picker' : 'project-editor'} style={[styles.modalCard, folderOpen && styles.folderPickerCard]}>
        <ScrollView keyboardDismissMode="on-drag" keyboardShouldPersistTaps="handled">
          <Text style={styles.modalEyebrow}>{host?.name || 'Host'} · {host?.phase === 'online' ? 'Connected' : 'Offline'}</Text>
          <Text style={styles.modalTitle}>{folderOpen ? 'Choose a project folder' : project ? 'Edit project' : 'Add project'}</Text>
          {folderOpen ? <>
            <Text style={styles.folderPickerHelp}>Pick a recent project or browse folders on this host.</Text>
            <View style={styles.folderSearch}><Feather name="search" size={17} color={colors.muted} /><TextInput testID="project-folder-search" value={folderQuery} onChangeText={setFolderQuery} placeholder={`Search folders on ${host?.name || 'this host'}`} placeholderTextColor={colors.muted} style={styles.folderSearchInput} /></View>
            {recentProjects.length ? <><Text style={styles.folderSectionTitle}>Recent projects</Text><View style={styles.recentProjects}>{recentProjects.map((recent) => <Pressable key={recent.projectId || recent.path} testID={`recent-project-${recent.name}`} accessibilityRole="button" accessibilityLabel={`Browse ${recent.name}`} onPress={() => void loadFolders({ path: recent.hostPath || recent.path })} style={({ pressed }) => [styles.recentProject, pressed && styles.pressed]}><View style={[styles.recentProjectIcon, { backgroundColor: recent.color || colors.accent }]}>{projectIcon(recent)}</View><Text style={styles.recentProjectName} numberOfLines={1}>{recent.name}</Text></Pressable>)}</View></> : null}
            {folderResult?.locations?.length ? <><Text style={styles.folderSectionTitle}>Locations</Text><ScrollView horizontal keyboardDismissMode="on-drag" showsHorizontalScrollIndicator={false} contentContainerStyle={styles.folderLocations}>{folderResult.locations.map((location) => <Pressable key={location.rootId || location.path || location.name} accessibilityRole="button" onPress={() => void loadFolders({ path: location.path, rootId: location.rootId })} style={styles.folderLocation}><Feather name="hard-drive" size={14} color={colors.accent} /><Text style={styles.folderLocationText}>{location.name}</Text></Pressable>)}</ScrollView></> : null}
            <Text style={styles.folderSectionTitle}>Browse folders</Text>
            <View style={styles.folderPathRow}><Pressable accessibilityRole="button" accessibilityLabel="Parent folder" disabled={!folderResult?.parentPath || folderBusy} onPress={() => void loadFolders({ path: folderResult?.parentPath || undefined })} style={[styles.folderBack, !folderResult?.parentPath && styles.disabled]}><Feather name="arrow-left" size={17} color={colors.text} /></Pressable><Text style={styles.folderCurrentPath} numberOfLines={1}>{folderResult?.path || 'Loading…'}</Text></View>
            {folderBusy ? <ActivityIndicator color={colors.accent} style={styles.folderLoader} /> : folderError ? <View style={styles.folderEmpty}><Text style={styles.folderErrorText}>{folderError}</Text><Pressable accessibilityRole="button" onPress={() => void loadFolders()} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>Try again</Text></Pressable></View> : <View style={styles.folderList}>{visibleDirectories.map((directory) => <Pressable key={directory.path} testID={`project-folder-${directory.name}`} accessibilityRole="button" accessibilityLabel={`Open folder ${directory.name}`} onPress={() => void loadFolders({ path: directory.path })} style={({ pressed }) => [styles.folderRow, pressed && styles.folderRowPressed]}><View style={styles.folderGlyph}><Feather name="folder" size={18} color={colors.accent} /></View><Text style={styles.folderName} numberOfLines={1}>{directory.name}</Text><Feather name="chevron-right" size={17} color={colors.muted} /></Pressable>)}{!visibleDirectories.length ? <View style={styles.folderEmpty}><Text style={styles.folderEmptyText}>{folderQuery ? 'No folders match your search.' : 'This folder has no subfolders. You can still choose it.'}</Text></View> : null}</View>}
          </> : <>
            {!cloudNew ? <Field styles={styles} testID="project-name-input" label="Name" value={values.name} onChangeText={(name) => update({ name })} placeholder="Project name" /> : null}
            {cloudNew && capabilities.has('project.clone') ? <Field styles={styles} label="Repository URL (optional)" value={values.url} onChangeText={(url) => update({ url })} placeholder="https://github.com/team/repo.git" /> : null}
            {cloudNew ? <View style={styles.field}><Text style={styles.fieldLabel}>Allowed root</Text><View style={styles.choiceRow}>{roots.map((root) => <Pressable key={root.rootId} accessibilityRole="radio" accessibilityState={{ checked: values.rootId === root.rootId }} onPress={() => update({ rootId: root.rootId })} style={[styles.choice, values.rootId === root.rootId && styles.choiceActive]}><Text style={styles.choiceText}>{root.name}</Text></Pressable>)}</View></View> : null}
            <View style={styles.field}><Text style={styles.fieldLabel}>{cloudNew ? 'Folder inside root' : 'Folder path'}</Text><TextInput testID="project-path-input" value={values.path} onChangeText={(path) => update({ path })} placeholder={cloudNew ? 'apps/my-project' : host?.platform === 'win32' ? 'C:\\Projects\\my-project' : '/Users/me/Projects/my-project'} placeholderTextColor={styles.placeholder.color} style={styles.input} />{canBrowse ? <Pressable testID="choose-project-folder" accessibilityRole="button" accessibilityLabel="Choose project folder" onPress={openFolders} style={styles.chooseFolderButton}><Feather name="folder" size={17} color={colors.accent} /><Text style={styles.chooseFolderText}>Choose folder…</Text></Pressable> : null}<Text style={styles.fieldHelp}>Choose a folder from this host, or paste a path manually.</Text></View>
            {!cloudNew ? <><Text style={styles.fieldLabel}>Icon</Text><View style={styles.choiceRow}>{ICONS.map((icon) => <Pressable key={icon} accessibilityRole="radio" accessibilityState={{ checked: values.icon === `emoji:${icon}` }} onPress={() => update({ icon: `emoji:${icon}` })} style={[styles.iconChoice, values.icon === `emoji:${icon}` && styles.choiceActive]}><Text style={s.iconChoiceText}>{icon}</Text></Pressable>)}</View>{project && aiAvailable ? <View style={styles.aiBox}><Field styles={styles} label="Codex icon idea" value={iconIdea} onChangeText={setIconIdea} placeholder="A bold swarm orbiting a terminal" /><Pressable testID="generate-project-icon" accessibilityRole="button" disabled={!iconIdea.trim() || busy} onPress={() => generateIcon(iconIdea.trim())} style={[styles.secondaryButton, (!iconIdea.trim() || busy) && styles.disabled]}><Text style={styles.secondaryButtonText}>Generate with Codex</Text></Pressable><Text style={styles.aiCopy}>Runs in the background. You can save or close this window.</Text></View> : null}<Text style={styles.fieldLabel}>Color</Text><View style={styles.choiceRow}>{COLORS.map((color) => <Pressable key={color} accessibilityRole="radio" accessibilityLabel={`Use color ${color}`} accessibilityState={{ checked: values.color === color }} onPress={() => update({ color })} style={[s.colorChoice, { backgroundColor: color }, values.color === color && { borderColor: colors.text }]} />)}</View></> : null}
          </>}
        </ScrollView>
        {folderOpen ? <View style={styles.folderActions}><Pressable onPress={() => setFolderOpen(false)} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>Cancel</Text></Pressable><Text style={styles.folderSelection} numberOfLines={1}>{folderResult?.path || ''}</Text><Pressable testID="use-project-folder" accessibilityRole="button" disabled={!folderResult || folderBusy} onPress={() => { if (!folderResult) return; update({ path: folderResult.path, rootId: folderResult.rootId || values.rootId }); setFolderOpen(false); }} style={[styles.primaryButton, (!folderResult || folderBusy) && styles.disabled]}><Text style={styles.primaryButtonText}>Choose folder</Text></Pressable></View> : <View style={styles.modalActions}>{remove ? <Pressable accessibilityRole="button" accessibilityLabel="Remove project" disabled={busy} onPress={remove} style={styles.dangerButton}><Text style={styles.dangerButtonText}>Remove</Text></Pressable> : <View />}<View style={styles.row}><Pressable onPress={close} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>Cancel</Text></Pressable><Pressable testID="save-project" accessibilityRole="button" disabled={!valid || busy} onPress={() => save(values)} style={[styles.primaryButton, (!valid || busy) && styles.disabled]}>{busy ? <ActivityIndicator color={colors.accentText} /> : <Text style={styles.primaryButtonText}>Save</Text>}</Pressable></View></View>}
      </Pressable>
    </Pressable>
  </Modal>;
}

type TaskValues = Pick<RuntimeTask, 'title' | 'description' | 'status' | 'plan' | 'implementation' | 'labels'>;
function TaskEditor({ open, close, task, defaultStatus, colors, styles, busy, save, remove }: { open: boolean; close: () => void; task: RuntimeTask | null; defaultStatus: RuntimeTask['status']; colors: Colors; styles: ReturnType<typeof themed>; busy: boolean; save: (values: TaskValues) => void; remove?: () => void }) {
  const [title, setTitle] = useState(''); const [description, setDescription] = useState(''); const [status, setStatus] = useState<RuntimeTask['status']>('pending'); const [labels, setLabels] = useState(''); const [plan, setPlan] = useState(''); const [implementation, setImplementation] = useState('');
  useEffect(() => { if (!open) return; setTitle(task?.title || ''); setDescription(task?.description || ''); setStatus(task?.status || defaultStatus); setLabels((task?.labels || []).map((label) => typeof label === 'string' ? label : label.text).join(', ')); setPlan(task?.plan || ''); setImplementation(task?.implementation || ''); }, [open, task, defaultStatus]);
  return <Modal visible={open} transparent animationType="fade" onRequestClose={close}><Pressable accessible={false} accessibilityRole="button" accessibilityLabel="Close task editor" onPress={close} style={styles.modalBackdrop}><Pressable accessible={false} accessibilityRole="none" onPress={() => {}} style={styles.modalCard}><ScrollView keyboardDismissMode="on-drag" keyboardShouldPersistTaps="handled"><Text style={styles.modalTitle}>{task ? 'Edit task' : 'New task'}</Text><Field styles={styles} testID="task-title-input" label="Title" value={title} onChangeText={setTitle} /><Field styles={styles} label="Description" value={description} onChangeText={setDescription} multiline /><Text style={styles.fieldLabel}>Status</Text><View style={styles.choiceRow}>{STATUSES.map(([value, label]) => <Pressable key={value} accessibilityRole="radio" accessibilityState={{ checked: status === value }} onPress={() => setStatus(value)} style={[styles.choice, status === value && styles.choiceActive]}><Text style={styles.choiceText}>{label}</Text></Pressable>)}</View><Field styles={styles} label="Labels" value={labels} onChangeText={setLabels} placeholder="mobile, relay" /><Field styles={styles} label="Plan" value={plan} onChangeText={setPlan} multiline /><Field styles={styles} label="Implementation notes" value={implementation} onChangeText={setImplementation} multiline /><View style={styles.modalActions}>{remove ? <Pressable accessibilityRole="button" accessibilityLabel="Delete task" disabled={busy} onPress={remove} style={styles.dangerButton}><Text style={styles.dangerButtonText}>Delete</Text></Pressable> : <View />}<View style={styles.row}><Pressable onPress={close} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>Cancel</Text></Pressable><Pressable testID="save-task" accessibilityRole="button" disabled={!title.trim() || busy} onPress={() => save({ title, description, status, labels: labels.split(',').map((label) => label.trim()).filter(Boolean), plan, implementation })} style={[styles.primaryButton, (!title.trim() || busy) && styles.disabled]}>{busy ? <ActivityIndicator color={colors.accentText} /> : <Text style={styles.primaryButtonText}>Save</Text>}</Pressable></View></View></ScrollView></Pressable></Pressable></Modal>;
}

const s = StyleSheet.create({ projectImage: { width: 34, height: 34, borderRadius: 9 }, projectEmoji: { fontSize: 24 }, projectInitial: { fontSize: 17, fontWeight: '800', color: '#FFF' }, loader: { marginTop: 48 }, iconChoiceText: { fontSize: 22 }, colorChoice: { width: 30, height: 30, borderRadius: 15, borderWidth: 3, borderColor: 'transparent' } });

function themed(c: Colors) {
  return StyleSheet.create({
    screen: { flex: 1, minHeight: 0, backgroundColor: c.background },
    screenDesktop: { paddingHorizontal: 28 },
    field: { gap: 7, marginTop: 16 },
    fieldLabel: { color: c.secondary, fontSize: 12, fontWeight: '700', letterSpacing: .5 },
    input: { minHeight: 44, borderWidth: 1, borderColor: c.border, borderRadius: 10, paddingHorizontal: 12, color: c.text },
    textarea: { minHeight: 84, paddingTop: 12, textAlignVertical: 'top' },
    placeholder: { color: c.muted },
    fieldHelp: { color: c.muted, fontSize: 11 },
    aiBox: { marginTop: 12, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface, gap: 9 },
    aiCopy: { color: c.muted, fontSize: 11 },
    header: { paddingHorizontal: 20, paddingTop: 18, paddingBottom: 18, flexDirection: 'row', alignItems: 'center', gap: 12, flexShrink: 0 },
    title: { color: c.text, fontSize: 30, fontWeight: '800', letterSpacing: -.9 },
    hosts: { paddingHorizontal: 20, paddingTop: 10, paddingBottom: 8, gap: 6 },
    hostChip: { minHeight: 44, paddingHorizontal: 11, borderRadius: 10, justifyContent: 'center' },
    hostChipActive: { backgroundColor: c.elevated },
    hostChipText: { color: c.secondary, fontSize: 12, fontWeight: '600' },
    hostChipTextActive: { color: c.accent },
    projectGrid: { paddingHorizontal: 20, paddingBottom: 20 },
    projectCard: { minHeight: 72, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border, flexDirection: 'row', alignItems: 'center', gap: 12 },
    projectIcon: { width: 40, height: 40, borderRadius: 11, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
    grow: { flex: 1 },
    projectName: { color: c.text, fontSize: 14, fontWeight: '700' },
    projectPath: { color: c.secondary, fontSize: 11, marginTop: 5 },
    pagination: { flexShrink: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 10 },
    boardToolbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44, marginBottom: -6 },
    boardSummary: { color: c.secondary, fontSize: 12 },
    row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    primaryButton: { minHeight: 40, paddingHorizontal: 14, borderRadius: 10, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center' },
    primaryButtonText: { color: c.accentText, fontSize: 13, fontWeight: '800' },
    secondaryButton: { minHeight: 40, paddingHorizontal: 13, borderRadius: 10, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface, alignItems: 'center', justifyContent: 'center' },
    secondaryButtonText: { color: c.text, fontSize: 13, fontWeight: '700' },
    boardDesktop: { flexGrow: 1, paddingHorizontal: 18, paddingBottom: 18, gap: 12 },
    column: { width: 290, padding: 10, borderRadius: 14, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface, gap: 9 },
    columnHeader: { padding: 4, flexDirection: 'row', alignItems: 'center', gap: 8 },
    columnTitle: { flex: 1, color: c.text, fontSize: 13, fontWeight: '800', textTransform: 'uppercase', letterSpacing: .5 },
    count: { color: c.muted, fontSize: 12, fontWeight: '800' },
    boardMobile: { paddingHorizontal: 20, paddingBottom: 20, gap: 12 },
    taskCard: { padding: 15, borderRadius: 15, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface, marginBottom: 1 },
    taskTitle: { color: c.text, fontSize: 16, fontWeight: '700', lineHeight: 23, letterSpacing: -.2 },
    taskDescription: { color: c.secondary, fontSize: 12, lineHeight: 19, marginTop: 7 },
    labels: { flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 10 },
    label: { paddingHorizontal: 7, paddingVertical: 4, borderRadius: 5, backgroundColor: c.elevated },
    labelText: { color: c.secondary, fontSize: 10 },
    empty: { paddingVertical: 32, paddingHorizontal: 12, alignItems: 'center' },
    emptyTitle: { color: c.text, fontSize: 17, fontWeight: '800' },
    emptyCopy: { color: c.secondary, fontSize: 13, textAlign: 'center', marginTop: 7, maxWidth: 360, lineHeight: 19 },
    modalBackdrop: { flex: 1, backgroundColor: '#000A', padding: 16, alignItems: 'center', justifyContent: 'center' },
    modalCard: { width: '100%', maxWidth: 560, maxHeight: '90%', padding: 20, borderRadius: 18, backgroundColor: c.elevated, borderWidth: 1, borderColor: c.border },
    folderPickerCard: { maxWidth: 690, height: '90%' },
    modalEyebrow: { color: c.accent, fontSize: 11, fontWeight: '800', letterSpacing: 1 },
    modalTitle: { color: c.text, fontSize: 23, fontWeight: '800', marginTop: 4 },
    folderPickerHelp: { color: c.muted, fontSize: 12, marginTop: 5 },
    folderSearch: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 9, marginTop: 18, paddingHorizontal: 12, borderWidth: 1, borderColor: c.border, borderRadius: 12, backgroundColor: c.background },
    folderSearchInput: { minWidth: 0, flex: 1, color: c.text, fontSize: 12 },
    folderSectionTitle: { color: c.muted, fontSize: 10, fontWeight: '800', letterSpacing: .8, textTransform: 'uppercase', marginTop: 17, marginBottom: 9 },
    recentProjects: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    recentProject: { minWidth: 130, minHeight: 68, flexGrow: 1, flexBasis: 130, flexDirection: 'row', alignItems: 'center', gap: 9, padding: 10, borderWidth: 1, borderColor: c.border, borderRadius: 13, backgroundColor: c.surface },
    recentProjectIcon: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center', overflow: 'hidden', borderRadius: 10 },
    recentProjectName: { minWidth: 0, flex: 1, color: c.text, fontSize: 11, fontWeight: '700' },
    folderLocations: { gap: 7 },
    folderLocation: { minHeight: 34, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, borderWidth: 1, borderColor: c.border, borderRadius: 9, backgroundColor: c.surface },
    folderLocationText: { color: c.text, fontSize: 11, fontWeight: '700' },
    folderPathRow: { minHeight: 38, flexDirection: 'row', alignItems: 'center', gap: 8 },
    folderBack: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: c.border, borderRadius: 9, backgroundColor: c.surface },
    folderCurrentPath: { minWidth: 0, flex: 1, color: c.secondary, fontSize: 11, fontWeight: '700' },
    folderLoader: { marginVertical: 44 },
    folderList: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border },
    folderRow: { minHeight: 54, flexDirection: 'row', alignItems: 'center', gap: 11, paddingHorizontal: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border, borderRadius: 9 },
    folderRowPressed: { backgroundColor: `${c.accent}12` },
    folderGlyph: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center', borderRadius: 9, backgroundColor: c.surface },
    folderName: { minWidth: 0, flex: 1, color: c.text, fontSize: 13, fontWeight: '700' },
    folderEmpty: { minHeight: 110, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 20 },
    folderEmptyText: { color: c.secondary, textAlign: 'center', fontSize: 12, lineHeight: 18 },
    folderErrorText: { color: c.danger, textAlign: 'center', fontSize: 12 },
    folderActions: { flexDirection: 'row', alignItems: 'center', gap: 9, marginHorizontal: -20, marginBottom: -20, marginTop: 14, padding: 13, borderTopWidth: 1, borderTopColor: c.border, backgroundColor: c.surface },
    folderSelection: { minWidth: 0, flex: 1, color: c.secondary, fontSize: 10, fontWeight: '700' },
    chooseFolderButton: { minHeight: 42, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderWidth: 1, borderColor: `${c.accent}88`, borderRadius: 10, backgroundColor: `${c.accent}12` },
    chooseFolderText: { color: c.text, fontSize: 12, fontWeight: '800' },
    choiceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
    choice: { minHeight: 34, paddingHorizontal: 11, borderRadius: 9, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface, alignItems: 'center', justifyContent: 'center' },
    choiceActive: { borderColor: c.accent, backgroundColor: `${c.accent}22` },
    choiceText: { color: c.text, fontSize: 12, fontWeight: '650' as '600' },
    iconChoice: { width: 42, height: 42, borderRadius: 10, borderWidth: 1, borderColor: c.border, alignItems: 'center', justifyContent: 'center' },
    modalActions: { marginTop: 22, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
    dangerButton: { minHeight: 40, paddingHorizontal: 13, justifyContent: 'center' },
    dangerButtonText: { color: c.danger, fontSize: 13, fontWeight: '800' },
    disabled: { opacity: .45 },
    pressed: { opacity: .72 },
    subtitle: { color: c.secondary, fontSize: 12, marginTop: 6 },
    addButton: { width: 44, height: 44, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: c.accent },
    search: { flexShrink: 0, flexDirection: 'row', alignItems: 'center', gap: 9, marginHorizontal: 20, minHeight: 44, paddingHorizontal: 12, borderRadius: 12, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface },
    searchInput: { flex: 1, minWidth: 0, minHeight: 44, color: c.text, fontSize: 13 },
    hostStrip: { flexGrow: 0, flexShrink: 0, height: 62 },
    groupHeading: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingTop: 19, paddingBottom: 8 },
    groupName: { color: c.secondary, flex: 1, fontSize: 12, fontWeight: '600' },
    connection: { color: c.secondary, fontSize: 10 },
    offlineCopy: { color: c.secondary, fontSize: 11, marginTop: 8, lineHeight: 17 },
    projectSelect: { flexShrink: 0, flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: 20, marginBottom: 16, padding: 12, borderRadius: 14, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface },
    statusTabs: { flexDirection: 'row', flexShrink: 0, marginHorizontal: 20, marginTop: 13, borderBottomWidth: 1, borderBottomColor: c.border },
    statusTab: { flex: 1, minHeight: 66, alignItems: 'center', justifyContent: 'center', gap: 5, borderBottomWidth: 3, borderBottomColor: 'transparent', paddingBottom: 8 },
    statusTabActive: { borderBottomColor: c.accent },
    statusCount: { color: c.secondary, fontSize: 22, fontWeight: '600', fontVariant: ['tabular-nums'] },
    statusLabel: { color: c.secondary, fontSize: 10, fontWeight: '600' },
    statusActiveText: { color: c.accent },
    iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
    taskFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border, marginTop: 10, paddingTop: 3 },
    taskId: { color: c.secondary, fontSize: 10 },
    moveButton: { minHeight: 44, paddingLeft: 10, flexDirection: 'row', alignItems: 'center', gap: 5 },
    moveText: { color: c.accent, fontSize: 12, fontWeight: '600' },
    inlineAdd: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
    notice: { flexDirection: 'row', alignItems: 'center', marginHorizontal: 20, paddingVertical: 10, gap: 10 },
    noticeText: { color: c.secondary, fontSize: 12, lineHeight: 18, flex: 1 },
    retryButton: { minHeight: 44, justifyContent: 'center' },
    pickerBackdrop: { flex: 1, justifyContent: Platform.OS === 'web' ? 'center' : 'flex-end', alignItems: 'center', backgroundColor: '#0009' },
    pickerSheet: { width: '100%', maxWidth: 480, maxHeight: '85%', paddingBottom: 24, borderTopLeftRadius: 24, borderTopRightRadius: 24, borderBottomLeftRadius: Platform.OS === 'web' ? 24 : 0, borderBottomRightRadius: Platform.OS === 'web' ? 24 : 0, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface, overflow: 'hidden' },
    pickerHeader: { flexShrink: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 10, marginBottom: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
    pickerTitle: { color: c.text, fontSize: 18, fontWeight: '700' },
    hostChoice: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 24 },
    detailBody: { paddingHorizontal: 24 },
    detailPath: { color: c.secondary, fontSize: 13, lineHeight: 21, marginTop: 20 },
    moveTitle: { color: c.secondary, fontSize: 13, lineHeight: 20, marginHorizontal: 24, marginBottom: 14 },
  });
}
