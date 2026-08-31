import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { AppDialog, AppSwitch, EmptyState, InlineSpinner, useToast } from '../../../shared/ui';
import CredentialImageField, { type CredentialImageItemView } from '../components/CredentialImageField';
import {
  emptyCredentialProfile,
  type CredentialCertificate,
  type CredentialEmployee,
  type CredentialImage,
  type CredentialImageFieldKey,
  type CredentialLibraryMutationResult,
  type CredentialLibraryProfile,
  type CredentialLibrarySnapshot,
  type CredentialOtherMaterial,
  type CredentialOwnerType,
  type CredentialProject,
  type CredentialRecord,
  type CredentialRecordSavePayload,
} from '../types';

type CredentialTab = 'basic' | 'intro' | 'qualification' | 'employee' | 'project' | 'finance' | 'other' | 'watermark';
type EditorType = 'certificate' | 'employee' | 'project' | 'other';

interface DraftImage {
  draftId: string;
  fieldKey: CredentialImageFieldKey;
  file: File;
  url: string;
  customName: string;
}

interface EditorState {
  type: EditorType;
  record: CredentialRecord;
  existingImages: CredentialImage[];
  removedImageIds: string[];
  newImages: DraftImage[];
  imageNameDrafts: Record<string, string>;
}

type PendingDelete =
  | { kind: 'image'; id: string; label: string }
  | { kind: EditorType; id: string; label: string };

const tabs: Array<{ id: CredentialTab; label: string }> = [
  { id: 'basic', label: '基本信息' },
  { id: 'intro', label: '公司介绍' },
  { id: 'qualification', label: '资质' },
  { id: 'employee', label: '员工' },
  { id: 'project', label: '业绩' },
  { id: 'finance', label: '财务信息' },
  { id: 'other', label: '其他' },
  { id: 'watermark', label: '水印' },
];

const qualificationImageFields: Array<{ fieldKey: CredentialImageFieldKey; title: string }> = [
  { fieldKey: 'businessLicense', title: '营业执照' },
  { fieldKey: 'legalRepresentativeIdEmblem', title: '法定代表人身份证国徽面' },
  { fieldKey: 'legalRepresentativeIdPortrait', title: '法定代表人身份证人像面' },
  { fieldKey: 'legalRepresentativeAuthorization', title: '法定代表人授权委托书' },
  { fieldKey: 'authorizedRepresentativeIdEmblem', title: '授权代表身份证国徽面' },
  { fieldKey: 'authorizedRepresentativeIdPortrait', title: '授权代表身份证人像面' },
  { fieldKey: 'basicDepositAccountInfo', title: '企业基本存款账户信息单' },
  { fieldKey: 'creditChinaReport', title: '信用中国网站企业信用信息报告' },
  { fieldKey: 'governmentProcurementRecord', title: '中国政府采购网严重违法失信行为记录查询截图' },
  { fieldKey: 'enterpriseCreditReport', title: '国家企业信用信息公示系统企业信用信息公示报告' },
  { fieldKey: 'dishonestEnforcementQuery', title: '中国执行信息公开网失信被执行人查询截图' },
];

const employeeImageFields: Array<{ fieldKey: CredentialImageFieldKey; title: string }> = [
  { fieldKey: 'employeeSocialSecurity', title: '社保信息' },
  { fieldKey: 'employeeIdEmblem', title: '身份证国徽面' },
  { fieldKey: 'employeeIdPortrait', title: '身份证人像面' },
  { fieldKey: 'laborContract', title: '劳动合同' },
  { fieldKey: 'educationCertificate', title: '学历证书' },
  { fieldKey: 'driverLicense', title: '驾驶证' },
];

const projectImageFields: Array<{ fieldKey: CredentialImageFieldKey; title: string }> = [
  { fieldKey: 'projectContract', title: '合同' },
  { fieldKey: 'bidWinningNotice', title: '中标通知书' },
  { fieldKey: 'projectAcceptanceCertificate', title: '项目验收证明' },
  { fieldKey: 'paymentInvoice', title: '回款发票' },
];

const projectTypeLabels: Record<string, string> = {
  service: '服务',
  goods: '货物',
  construction: '工程',
};

/** 创建空白其他证书。 */
function createEmptyCertificate(): CredentialCertificate {
  return { certificateId: '', name: '', number: '', validityMode: '', validFrom: '', validTo: '', createdAt: '', updatedAt: '' };
}

/** 创建空白员工档案。 */
function createEmptyEmployee(): CredentialEmployee {
  return {
    employeeId: '', name: '', idNumber: '', position: '', professionalTitle: '', gender: '', phone: '',
    idValidityMode: '', idValidFrom: '', idValidTo: '', education: '', school: '', major: '', introduction: '', createdAt: '', updatedAt: '',
  };
}

/** 创建空白业绩。 */
function createEmptyProject(): CredentialProject {
  return {
    projectId: '', projectName: '', projectNumber: '', customerName: '', projectType: '', projectManager: '',
    contractAmount: '', startDate: '', endDate: '', projectStatus: '', introduction: '', createdAt: '', updatedAt: '',
  };
}

/** 创建空白其他资料。 */
function createEmptyOtherMaterial(): CredentialOtherMaterial {
  return { materialId: '', name: '', note: '', createdAt: '', updatedAt: '' };
}

/** 统一表单字段标签和布局。 */
function FormField({ label, hint, wide = false, children }: { label: string; hint?: string; wide?: boolean; children: ReactNode }) {
  return (
    <label className={`credential-form-field${wide ? ' is-wide' : ''}`}>
      <span>{label}</span>
      {children}
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}

/** 单企业资信库页面。 */
function CredentialLibraryPage({ developerMode }: { developerMode: boolean }) {
  const { showToast, dismissToast } = useToast();
  const profileSaveToastIdRef = useRef<number | null>(null);
  const [snapshot, setSnapshot] = useState<CredentialLibrarySnapshot | null>(null);
  const [profile, setProfile] = useState<CredentialLibraryProfile>(emptyCredentialProfile);
  const [activeTab, setActiveTab] = useState<CredentialTab>('basic');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [profileStatus, setProfileStatus] = useState('');
  const [employeeSearch, setEmployeeSearch] = useState('');
  const [projectSearch, setProjectSearch] = useState('');
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [importConfirmOpen, setImportConfirmOpen] = useState(false);

  /** 首次进入时读取资信库快照。 */
  useEffect(() => {
    let mounted = true;
    void window.yibiao.credentialLibrary.load()
      .then((data) => {
        if (!mounted) return;
        setSnapshot(data);
        setProfile(data.profile);
      })
      .catch((error) => showToast(error instanceof Error ? error.message : '读取资信库失败', 'error'))
      .finally(() => mounted && setLoading(false));
    return () => { mounted = false; };
  }, [showToast]);

  const visibleEmployees = useMemo(() => {
    const keyword = employeeSearch.trim().toLowerCase();
    if (!keyword) return snapshot?.employees || [];
    return (snapshot?.employees || []).filter((item) => [item.name, item.idNumber, item.position, item.professionalTitle, item.phone]
      .some((value) => value.toLowerCase().includes(keyword)));
  }, [employeeSearch, snapshot?.employees]);

  const visibleProjects = useMemo(() => {
    const keyword = projectSearch.trim().toLowerCase();
    if (!keyword) return snapshot?.projects || [];
    return (snapshot?.projects || []).filter((item) => [item.projectName, item.projectNumber, item.customerName, item.projectManager, item.projectStatus]
      .some((value) => value.toLowerCase().includes(keyword)));
  }, [projectSearch, snapshot?.projects]);

  /** 更新企业表单草稿。 */
  const updateProfile = <K extends keyof CredentialLibraryProfile>(key: K, value: CredentialLibraryProfile[K]) => {
    setProfile((current) => ({ ...current, [key]: value }));
  };

  /** 保存企业单例字段，避免返回快照覆盖其他尚在输入的字段。 */
  const saveProfile = async (partial: Partial<CredentialLibraryProfile>) => {
    const changed = Object.entries(partial).some(([key, value]) => snapshot?.profile[key as keyof CredentialLibraryProfile] !== value);
    if (!changed) return;
    setProfileStatus('正在保存...');
    try {
      const data = await window.yibiao.credentialLibrary.saveProfile(partial);
      setSnapshot(data);
      setProfile((current) => ({ ...data.profile, ...current }));
      setProfileStatus('已保存');
      if (profileSaveToastIdRef.current !== null) dismissToast(profileSaveToastIdRef.current);
      profileSaveToastIdRef.current = showToast('保存成功', 'success');
    } catch (error) {
      setProfileStatus('保存失败');
      if (profileSaveToastIdRef.current !== null) {
        dismissToast(profileSaveToastIdRef.current);
        profileSaveToastIdRef.current = null;
      }
      showToast(error instanceof Error ? error.message : '保存资信信息失败', 'error');
    }
  };

  /** 选择测试目录并用其中的 JSON 和图片完整替换当前资信库。 */
  const importTestData = async () => {
    setImportConfirmOpen(false);
    setBusy('import-test-data');
    try {
      const result = await window.yibiao.credentialLibrary.importTestData();
      if (!result) return;
      setSnapshot(result.snapshot);
      setProfile(result.snapshot.profile);
      setProfileStatus('');
      if (profileSaveToastIdRef.current !== null) {
        dismissToast(profileSaveToastIdRef.current);
        profileSaveToastIdRef.current = null;
      }
      const { counts } = result;
      const summary = `${counts.employees} 名员工、${counts.projects} 项业绩、${counts.certificates} 项证书、${counts.otherMaterials} 项其他资料、${counts.images} 张图片`;
      if (result.fileDeleteFailures.length) {
        showToast(`测试数据已导入，但有 ${result.fileDeleteFailures.length} 张旧原图因被占用未能清理`, 'error');
      } else {
        showToast(`测试数据导入成功：${summary}`, 'success');
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : '导入测试数据失败', 'error');
    } finally {
      setBusy(null);
    }
  };

  /** 支持方向键、Home 和 End 切换顶部 Tab。 */
  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex = index;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = tabs.length - 1;
    else return;
    event.preventDefault();
    const next = tabs[nextIndex];
    setActiveTab(next.id);
    document.getElementById(`credential-tab-${next.id}`)?.focus();
  };

  /** 取得指定业务对象和图片栏目的图片。 */
  const getImages = (ownerType: CredentialOwnerType, ownerId: string, fieldKey?: CredentialImageFieldKey) =>
    (snapshot?.images || []).filter((image) => image.ownerType === ownerType && image.ownerId === ownerId && (!fieldKey || image.fieldKey === fieldKey));

  /** 上传企业单例栏目图片。 */
  const addProfileImages = async (fieldKey: CredentialImageFieldKey, files: File[]) => {
    const filePaths = files.map((file) => window.yibiao.file.getPathForFile(file)).filter(Boolean);
    if (!filePaths.length) {
      showToast('未能读取所选图片路径', 'error');
      return;
    }
    setBusy(`profile-image-${fieldKey}`);
    try {
      const data = await window.yibiao.credentialLibrary.addProfileImages(fieldKey, filePaths);
      setSnapshot(data);
      showToast(`已添加 ${filePaths.length} 张图片`, 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '添加图片失败', 'error');
    } finally {
      setBusy(null);
    }
  };

  /** 渲染企业单例的图片上传栏。 */
  const renderProfileImageField = (fieldKey: CredentialImageFieldKey, title: string, hint?: string) => {
    const images = getImages('profile', '1', fieldKey);
    return (
      <CredentialImageField
        key={fieldKey}
        title={title}
        hint={hint}
        images={images.map((image) => ({ id: image.imageId, name: image.originalName, url: image.assetUrl }))}
        disabled={busy !== null}
        onFiles={(files) => void addProfileImages(fieldKey, files)}
        onRemove={(image) => setPendingDelete({ kind: 'image', id: image.id, label: image.name })}
      />
    );
  };

  /** 打开列表记录新增或编辑弹窗。 */
  const openEditor = (type: EditorType, record?: CredentialRecord) => {
    const nextRecord = record || (type === 'certificate'
      ? createEmptyCertificate()
      : type === 'employee'
        ? createEmptyEmployee()
        : type === 'project'
          ? createEmptyProject()
          : createEmptyOtherMaterial());
    const ownerId = type === 'certificate'
      ? (nextRecord as CredentialCertificate).certificateId
      : type === 'employee'
        ? (nextRecord as CredentialEmployee).employeeId
        : type === 'project'
          ? (nextRecord as CredentialProject).projectId
          : (nextRecord as CredentialOtherMaterial).materialId;
    const existingImages = ownerId ? getImages(type, ownerId) : [];
    setEditor({
      type,
      record: { ...nextRecord },
      existingImages,
      removedImageIds: [],
      newImages: [],
      imageNameDrafts: Object.fromEntries(existingImages.map((image) => [image.imageId, image.customName])),
    });
  };

  /** 关闭编辑器并释放草稿图片预览地址。 */
  const closeEditor = () => {
    editor?.newImages.forEach((image) => URL.revokeObjectURL(image.url));
    setEditor(null);
  };

  /** 更新当前记录草稿字段。 */
  const updateEditorRecord = (property: string, value: string) => {
    setEditor((current) => current ? { ...current, record: { ...current.record, [property]: value } as CredentialRecord } : current);
  };

  /** 向当前记录图片栏目加入多张草稿图片。 */
  const addEditorImages = (fieldKey: CredentialImageFieldKey, files: File[]) => {
    const additions = files.map((file) => ({
      draftId: crypto.randomUUID(),
      fieldKey,
      file,
      url: URL.createObjectURL(file),
      customName: '',
    }));
    setEditor((current) => current ? { ...current, newImages: [...current.newImages, ...additions] } : current);
  };

  /** 从编辑草稿中移除已有或新增图片。 */
  const removeEditorImage = (image: CredentialImageItemView) => {
    setEditor((current) => {
      if (!current) return current;
      const draft = current.newImages.find((item) => item.draftId === image.id);
      if (draft) URL.revokeObjectURL(draft.url);
      return draft
        ? { ...current, newImages: current.newImages.filter((item) => item.draftId !== image.id) }
        : { ...current, removedImageIds: [...new Set([...current.removedImageIds, image.id])] };
    });
  };

  /** 修改技能证书图片的独立名称。 */
  const updateEditorImageName = (image: CredentialImageItemView, value: string) => {
    setEditor((current) => {
      if (!current) return current;
      const draftIndex = current.newImages.findIndex((item) => item.draftId === image.id);
      if (draftIndex >= 0) {
        const newImages = [...current.newImages];
        newImages[draftIndex] = { ...newImages[draftIndex], customName: value };
        return { ...current, newImages };
      }
      return { ...current, imageNameDrafts: { ...current.imageNameDrafts, [image.id]: value } };
    });
  };

  /** 返回当前编辑器内某个栏目的可见图片。 */
  const getEditorImageViews = (fieldKey: CredentialImageFieldKey): CredentialImageItemView[] => {
    if (!editor) return [];
    const existing = editor.existingImages
      .filter((image) => image.fieldKey === fieldKey && !editor.removedImageIds.includes(image.imageId))
      .map((image) => ({
        id: image.imageId,
        name: image.originalName,
        url: image.assetUrl,
        customName: editor.imageNameDrafts[image.imageId] ?? image.customName,
      }));
    const drafts = editor.newImages
      .filter((image) => image.fieldKey === fieldKey)
      .map((image) => ({ id: image.draftId, name: image.file.name, url: image.url, customName: image.customName, draft: true }));
    return [...existing, ...drafts];
  };

  /** 渲染记录编辑器内的图片栏目。 */
  const renderEditorImageField = (fieldKey: CredentialImageFieldKey, title: string, editableNames = false) => (
    <CredentialImageField
      key={fieldKey}
      title={title}
      hint={editableNames ? '可一次选择多张；每张图片分别填写证书名称。' : undefined}
      images={getEditorImageViews(fieldKey)}
      disabled={busy !== null}
      editableNames={editableNames}
      onFiles={(files) => addEditorImages(fieldKey, files)}
      onRemove={removeEditorImage}
      onCustomNameChange={updateEditorImageName}
    />
  );

  /** 保存当前列表记录和图片草稿。 */
  const saveEditor = async () => {
    if (!editor) return;
    const newImages = editor.newImages.map((image) => ({
      fieldKey: image.fieldKey,
      filePath: window.yibiao.file.getPathForFile(image.file),
      customName: image.customName,
    }));
    if (newImages.some((image) => !image.filePath)) {
      showToast('未能读取部分图片路径，请重新选择', 'error');
      return;
    }
    const payload = {
      record: editor.record,
      newImages,
      removedImageIds: editor.removedImageIds,
      imageNameUpdates: editor.existingImages.map((image) => ({
        imageId: image.imageId,
        customName: editor.imageNameDrafts[image.imageId] ?? image.customName,
      })),
    };
    setBusy(`save-${editor.type}`);
    try {
      let result: CredentialLibraryMutationResult;
      if (editor.type === 'certificate') {
        result = await window.yibiao.credentialLibrary.saveCertificate(payload as CredentialRecordSavePayload<CredentialCertificate>);
      } else if (editor.type === 'employee') {
        result = await window.yibiao.credentialLibrary.saveEmployee(payload as CredentialRecordSavePayload<CredentialEmployee>);
      } else if (editor.type === 'project') {
        result = await window.yibiao.credentialLibrary.saveProject(payload as CredentialRecordSavePayload<CredentialProject>);
      } else {
        result = await window.yibiao.credentialLibrary.saveOtherMaterial(payload as CredentialRecordSavePayload<CredentialOtherMaterial>);
      }
      setSnapshot(result.snapshot);
      if (result.fileDeleteFailures.length) {
        showToast(`资料已保存，但有 ${result.fileDeleteFailures.length} 张原图因被占用未能清理`, 'error');
      } else {
        showToast('保存成功', 'success');
      }
      closeEditor();
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存失败', 'error');
    } finally {
      setBusy(null);
    }
  };

  /** 执行图片或列表记录的永久删除。 */
  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setBusy(`delete-${pendingDelete.kind}`);
    try {
      let result: CredentialLibraryMutationResult;
      if (pendingDelete.kind === 'image') result = await window.yibiao.credentialLibrary.deleteImage(pendingDelete.id);
      else if (pendingDelete.kind === 'certificate') result = await window.yibiao.credentialLibrary.deleteCertificate(pendingDelete.id);
      else if (pendingDelete.kind === 'employee') result = await window.yibiao.credentialLibrary.deleteEmployee(pendingDelete.id);
      else if (pendingDelete.kind === 'project') result = await window.yibiao.credentialLibrary.deleteProject(pendingDelete.id);
      else result = await window.yibiao.credentialLibrary.deleteOtherMaterial(pendingDelete.id);
      setSnapshot(result.snapshot);
      setPendingDelete(null);
      if (result.fileDeleteFailures.length) {
        showToast(`数据已删除，但有 ${result.fileDeleteFailures.length} 张原图因被占用未能清理`, 'error');
      } else {
        showToast('删除成功', 'success');
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : '删除失败', 'error');
    } finally {
      setBusy(null);
    }
  };

  /** 渲染企业基本信息。 */
  const renderBasicPanel = () => (
    <section className="credential-section-card">
      <div className="credential-section-head">
        <div><strong>企业基本信息</strong><small>当前资信库固定维护一家企业，所有字段均可留空。</small></div>
        <span className="credential-save-status" aria-live="polite">{profileStatus}</span>
      </div>
      <div className="credential-form-grid">
        <FormField label="公司名称"><input value={profile.companyName} onChange={(event) => updateProfile('companyName', event.target.value)} onBlur={() => void saveProfile({ companyName: profile.companyName })} /></FormField>
        <FormField label="统一社会信用代码"><input value={profile.unifiedSocialCreditCode} onChange={(event) => updateProfile('unifiedSocialCreditCode', event.target.value)} onBlur={() => void saveProfile({ unifiedSocialCreditCode: profile.unifiedSocialCreditCode })} /></FormField>
        <FormField label="电话"><input type="tel" value={profile.phone} onChange={(event) => updateProfile('phone', event.target.value)} onBlur={() => void saveProfile({ phone: profile.phone })} /></FormField>
        <FormField label="邮箱"><input type="email" value={profile.email} onChange={(event) => updateProfile('email', event.target.value)} onBlur={() => void saveProfile({ email: profile.email })} /></FormField>
        <FormField label="法定代表人"><input value={profile.legalRepresentative} onChange={(event) => updateProfile('legalRepresentative', event.target.value)} onBlur={() => void saveProfile({ legalRepresentative: profile.legalRepresentative })} /></FormField>
        <FormField label="注册资本"><input value={profile.registeredCapital} placeholder="如：1000万元" onChange={(event) => updateProfile('registeredCapital', event.target.value)} onBlur={() => void saveProfile({ registeredCapital: profile.registeredCapital })} /></FormField>
        <FormField label="经营期限开始"><input type="date" value={profile.operatingPeriodStart} onChange={(event) => updateProfile('operatingPeriodStart', event.target.value)} onBlur={() => void saveProfile({ operatingPeriodStart: profile.operatingPeriodStart })} /></FormField>
        <FormField label="经营期限结束"><input type="date" value={profile.operatingPeriodEnd} onChange={(event) => updateProfile('operatingPeriodEnd', event.target.value)} onBlur={() => void saveProfile({ operatingPeriodEnd: profile.operatingPeriodEnd })} /></FormField>
        <FormField label="所在行业"><input value={profile.industry} onChange={(event) => updateProfile('industry', event.target.value)} onBlur={() => void saveProfile({ industry: profile.industry })} /></FormField>
        <FormField label="公司性质"><input value={profile.companyType} onChange={(event) => updateProfile('companyType', event.target.value)} onBlur={() => void saveProfile({ companyType: profile.companyType })} /></FormField>
        <FormField label="参保人数"><input type="number" min="0" value={profile.insuredEmployeeCount} onChange={(event) => updateProfile('insuredEmployeeCount', event.target.value)} onBlur={() => void saveProfile({ insuredEmployeeCount: profile.insuredEmployeeCount })} /></FormField>
        <FormField label="地址" wide><input value={profile.address} onChange={(event) => updateProfile('address', event.target.value)} onBlur={() => void saveProfile({ address: profile.address })} /></FormField>
        <FormField label="经营范围" wide><textarea rows={5} value={profile.businessScope} onChange={(event) => updateProfile('businessScope', event.target.value)} onBlur={() => void saveProfile({ businessScope: profile.businessScope })} /></FormField>
      </div>
    </section>
  );

  /** 渲染公司介绍。 */
  const renderIntroPanel = () => (
    <div className="credential-panel-stack">
      <section className="credential-section-card">
        <div className="credential-section-head"><div><strong>公司介绍</strong><small>用于统一维护企业简介、优势和服务能力。</small></div><span className="credential-save-status">{profileStatus}</span></div>
        <FormField label="公司介绍"><textarea rows={12} value={profile.companyIntro} onChange={(event) => updateProfile('companyIntro', event.target.value)} onBlur={() => void saveProfile({ companyIntro: profile.companyIntro })} /></FormField>
      </section>
      {renderProfileImageField('officeEnvironment', '办公环境', '支持上传多张办公室、生产场地或服务环境原图。')}
    </div>
  );

  /** 渲染资质资料。 */
  const renderQualificationPanel = () => (
    <div className="credential-panel-stack">
      <div className="credential-qualification-grid">
        {qualificationImageFields.map((item) => renderProfileImageField(item.fieldKey, item.title))}
      </div>
      <section className="credential-section-card">
        <div className="credential-list-toolbar">
          <div><strong>其他证书</strong><small>自定义证书名称、编号和有效期，证书图片支持多张。</small></div>
          <button type="button" className="primary-action" onClick={() => openEditor('certificate')}>新增证书</button>
        </div>
        {(snapshot?.certificates.length || 0) > 0 ? (
          <div className="credential-table-wrap">
            <table className="credential-table">
              <thead><tr><th>名称</th><th>编号</th><th>有效期</th><th>图片</th><th>操作</th></tr></thead>
              <tbody>{snapshot?.certificates.map((item) => (
                <tr key={item.certificateId}>
                  <td><strong>{item.name || '未命名证书'}</strong></td>
                  <td>{item.number || '-'}</td>
                  <td>{item.validityMode === 'long-term' ? '长期' : item.validityMode === 'range' ? [item.validFrom, item.validTo].filter(Boolean).join(' 至 ') || '-' : '-'}</td>
                  <td>{getImages('certificate', item.certificateId).length} 张</td>
                  <td className="credential-table-actions"><button type="button" className="text-button" onClick={() => openEditor('certificate', item)}>编辑</button><button type="button" className="text-button is-danger" onClick={() => setPendingDelete({ kind: 'certificate', id: item.certificateId, label: item.name || '未命名证书' })}>删除</button></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ) : <EmptyState title="暂无其他证书" hint="营业执照等固定资料可直接在上方上传；自定义证书从这里新增。" />}
      </section>
    </div>
  );

  /** 渲染员工列表。 */
  const renderEmployeePanel = () => (
    <section className="credential-section-card credential-list-card">
      <div className="credential-list-toolbar">
        <div><strong>员工档案</strong><small>集中维护人员信息、身份证明、劳动关系和技能证书。</small></div>
        <div className="credential-list-actions"><input type="search" value={employeeSearch} placeholder="搜索姓名、职务、身份证号" onChange={(event) => setEmployeeSearch(event.target.value)} /><button type="button" className="primary-action" onClick={() => openEditor('employee')}>新增员工</button></div>
      </div>
      {visibleEmployees.length ? (
        <div className="credential-table-wrap">
          <table className="credential-table">
            <thead><tr><th>姓名</th><th>职务 / 职称</th><th>联系电话</th><th>学历 / 专业</th><th>资料图片</th><th>操作</th></tr></thead>
            <tbody>{visibleEmployees.map((item) => (
              <tr key={item.employeeId}>
                <td><strong>{item.name || '未命名人员'}</strong><small>{item.idNumber || '未填写身份证号'}</small></td>
                <td>{[item.position, item.professionalTitle].filter(Boolean).join(' / ') || '-'}</td>
                <td>{item.phone || '-'}</td>
                <td>{[item.education, item.major].filter(Boolean).join(' / ') || '-'}</td>
                <td>{getImages('employee', item.employeeId).length} 张</td>
                <td className="credential-table-actions"><button type="button" className="text-button" onClick={() => openEditor('employee', item)}>编辑</button><button type="button" className="text-button is-danger" onClick={() => setPendingDelete({ kind: 'employee', id: item.employeeId, label: item.name || '未命名人员' })}>删除</button></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : <EmptyState title={employeeSearch ? '没有匹配的员工' : '暂无员工档案'} hint={employeeSearch ? '请调整搜索关键词。' : '点击“新增员工”录入人员信息和证明材料。'} />}
    </section>
  );

  /** 渲染业绩列表。 */
  const renderProjectPanel = () => (
    <section className="credential-section-card credential-list-card">
      <div className="credential-list-toolbar">
        <div><strong>项目业绩</strong><small>维护合同、中标、验收和回款材料。</small></div>
        <div className="credential-list-actions"><input type="search" value={projectSearch} placeholder="搜索项目、客户或负责人" onChange={(event) => setProjectSearch(event.target.value)} /><button type="button" className="primary-action" onClick={() => openEditor('project')}>新增业绩</button></div>
      </div>
      {visibleProjects.length ? (
        <div className="credential-table-wrap">
          <table className="credential-table">
            <thead><tr><th>项目名称</th><th>客户 / 类型</th><th>负责人</th><th>合同金额</th><th>状态</th><th>操作</th></tr></thead>
            <tbody>{visibleProjects.map((item) => (
              <tr key={item.projectId}>
                <td><strong>{item.projectName || '未命名项目'}</strong><small>{item.projectNumber || '未填写项目编号'}</small></td>
                <td>{[item.customerName, projectTypeLabels[item.projectType]].filter(Boolean).join(' / ') || '-'}</td>
                <td>{item.projectManager || '-'}</td>
                <td>{item.contractAmount || '-'}</td>
                <td>{item.projectStatus || '-'}</td>
                <td className="credential-table-actions"><button type="button" className="text-button" onClick={() => openEditor('project', item)}>编辑</button><button type="button" className="text-button is-danger" onClick={() => setPendingDelete({ kind: 'project', id: item.projectId, label: item.projectName || '未命名项目' })}>删除</button></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : <EmptyState title={projectSearch ? '没有匹配的业绩' : '暂无项目业绩'} hint={projectSearch ? '请调整搜索关键词。' : '点击“新增业绩”录入项目和证明材料。'} />}
    </section>
  );

  /** 渲染三类单条财务证明和开户行信息。 */
  const renderFinancePanel = () => {
    const proofs: Array<{ title: string; dateKey: 'taxCertificateDate' | 'auditReportDate' | 'socialSecurityCertificateDate'; noteKey: 'taxCertificateNote' | 'auditReportNote' | 'socialSecurityCertificateNote'; imageKey: CredentialImageFieldKey }> = [
      { title: '纳税证明', dateKey: 'taxCertificateDate', noteKey: 'taxCertificateNote', imageKey: 'taxCertificate' },
      { title: '财务审计报告', dateKey: 'auditReportDate', noteKey: 'auditReportNote', imageKey: 'auditReport' },
      { title: '社保缴纳证明', dateKey: 'socialSecurityCertificateDate', noteKey: 'socialSecurityCertificateNote', imageKey: 'socialSecurityCertificate' },
    ];
    return (
      <div className="credential-panel-stack">
        {proofs.map((proof) => (
          <section className="credential-section-card credential-finance-card" key={proof.imageKey}>
            <div className="credential-section-head"><div><strong>{proof.title}</strong><small>当前类别保存一条信息，图片可上传多张。</small></div><span className="credential-save-status">{profileStatus}</span></div>
            <div className="credential-form-grid">
              <FormField label="信息时间"><input type="date" value={profile[proof.dateKey]} onChange={(event) => updateProfile(proof.dateKey, event.target.value)} onBlur={() => void saveProfile({ [proof.dateKey]: profile[proof.dateKey] })} /></FormField>
              <FormField label="备注" wide><textarea rows={3} value={profile[proof.noteKey]} onChange={(event) => updateProfile(proof.noteKey, event.target.value)} onBlur={() => void saveProfile({ [proof.noteKey]: profile[proof.noteKey] })} /></FormField>
            </div>
            {renderProfileImageField(proof.imageKey, `${proof.title}图片`)}
          </section>
        ))}
        <section className="credential-section-card">
          <div className="credential-section-head"><div><strong>开户行信息</strong><small>维护企业基本账户及开户许可证原图。</small></div><span className="credential-save-status">{profileStatus}</span></div>
          <div className="credential-form-grid">
            <FormField label="开户名称"><input value={profile.bankAccountName} onChange={(event) => updateProfile('bankAccountName', event.target.value)} onBlur={() => void saveProfile({ bankAccountName: profile.bankAccountName })} /></FormField>
            <FormField label="银行账号"><input value={profile.bankAccountNumber} onChange={(event) => updateProfile('bankAccountNumber', event.target.value)} onBlur={() => void saveProfile({ bankAccountNumber: profile.bankAccountNumber })} /></FormField>
            <FormField label="开户银行"><input value={profile.bankName} onChange={(event) => updateProfile('bankName', event.target.value)} onBlur={() => void saveProfile({ bankName: profile.bankName })} /></FormField>
            <FormField label="银行行号"><input value={profile.bankRoutingNumber} onChange={(event) => updateProfile('bankRoutingNumber', event.target.value)} onBlur={() => void saveProfile({ bankRoutingNumber: profile.bankRoutingNumber })} /></FormField>
          </div>
          {renderProfileImageField('bankAccountLicense', '开户许可证')}
        </section>
      </div>
    );
  };

  /** 渲染其他资料列表。 */
  const renderOtherPanel = () => (
    <section className="credential-section-card credential-list-card">
      <div className="credential-list-toolbar"><div><strong>其他资料</strong><small>保存未归入固定分类的图片资料和备注。</small></div><button type="button" className="primary-action" onClick={() => openEditor('other')}>新增资料</button></div>
      {(snapshot?.otherMaterials.length || 0) > 0 ? (
        <div className="credential-table-wrap">
          <table className="credential-table">
            <thead><tr><th>资料名称</th><th>备注</th><th>图片</th><th>操作</th></tr></thead>
            <tbody>{snapshot?.otherMaterials.map((item) => (
              <tr key={item.materialId}>
                <td><strong>{item.name || '未命名资料'}</strong></td>
                <td>{item.note || '-'}</td>
                <td>{getImages('other', item.materialId).length} 张</td>
                <td className="credential-table-actions"><button type="button" className="text-button" onClick={() => openEditor('other', item)}>编辑</button><button type="button" className="text-button is-danger" onClick={() => setPendingDelete({ kind: 'other', id: item.materialId, label: item.name || '未命名资料' })}>删除</button></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : <EmptyState title="暂无其他资料" hint="点击“新增资料”保存自定义名称、图片和备注。" />}
    </section>
  );

  /** 渲染水印设置；本阶段只保存配置，不生成水印图。 */
  const renderWatermarkPanel = () => (
    <section className="credential-section-card credential-watermark-card">
      <div className="credential-section-head"><div><strong>图片水印</strong><small>工作区始终保存用户上传的原图；后续使用图片时再按此配置添加水印。</small></div><span className="credential-save-status">{profileStatus}</span></div>
      <div className="credential-switch-row">
        <div><strong>自动添加水印</strong><small>{profile.watermarkEnabled ? '使用资信图片时自动添加水印' : '使用资信图片时保持原图'}</small></div>
        <AppSwitch checked={profile.watermarkEnabled} onCheckedChange={(checked) => { updateProfile('watermarkEnabled', checked); void saveProfile({ watermarkEnabled: checked }); }} aria-label="是否自动添加水印" />
      </div>
      <FormField label="水印内容" hint="例如：仅限某某项目投标使用"><textarea rows={5} value={profile.watermarkContent} onChange={(event) => updateProfile('watermarkContent', event.target.value)} onBlur={() => void saveProfile({ watermarkContent: profile.watermarkContent })} /></FormField>
    </section>
  );

  /** 渲染当前记录编辑弹窗正文。 */
  const renderEditorBody = () => {
    if (!editor) return null;
    const record = editor.record as unknown as Record<string, string>;
    if (editor.type === 'certificate') {
      return (
        <div className="credential-editor-body">
          <section className="credential-editor-section">
            <div className="credential-form-grid">
              <FormField label="名称"><input value={record.name || ''} onChange={(event) => updateEditorRecord('name', event.target.value)} /></FormField>
              <FormField label="编号"><input value={record.number || ''} onChange={(event) => updateEditorRecord('number', event.target.value)} /></FormField>
              <FormField label="有效期方式"><select value={record.validityMode || ''} onChange={(event) => {
                const validityMode = event.target.value;
                setEditor((current) => current ? {
                  ...current,
                  record: {
                    ...current.record,
                    validityMode,
                    ...(validityMode === 'range' ? {} : { validFrom: '', validTo: '' }),
                  } as CredentialRecord,
                } : current);
              }}><option value="">未设置</option><option value="range">日期范围</option><option value="long-term">长期</option></select></FormField>
              {record.validityMode === 'range' ? <><FormField label="有效期开始"><input type="date" value={record.validFrom || ''} onChange={(event) => updateEditorRecord('validFrom', event.target.value)} /></FormField><FormField label="有效期结束"><input type="date" value={record.validTo || ''} onChange={(event) => updateEditorRecord('validTo', event.target.value)} /></FormField></> : null}
            </div>
          </section>
          {renderEditorImageField('certificateImages', '证书图片')}
        </div>
      );
    }
    if (editor.type === 'employee') {
      return (
        <div className="credential-editor-body">
          <section className="credential-editor-section">
            <h3>人员信息</h3>
            <div className="credential-form-grid">
              <FormField label="姓名"><input value={record.name || ''} onChange={(event) => updateEditorRecord('name', event.target.value)} /></FormField>
              <FormField label="身份证号"><input value={record.idNumber || ''} onChange={(event) => updateEditorRecord('idNumber', event.target.value)} /></FormField>
              <FormField label="职务"><input value={record.position || ''} onChange={(event) => updateEditorRecord('position', event.target.value)} /></FormField>
              <FormField label="职称"><input value={record.professionalTitle || ''} onChange={(event) => updateEditorRecord('professionalTitle', event.target.value)} /></FormField>
              <FormField label="性别"><select value={record.gender || ''} onChange={(event) => updateEditorRecord('gender', event.target.value)}><option value="">未选择</option><option value="男">男</option><option value="女">女</option></select></FormField>
              <FormField label="联系电话"><input type="tel" value={record.phone || ''} onChange={(event) => updateEditorRecord('phone', event.target.value)} /></FormField>
              <FormField label="身份证有效期方式"><select value={record.idValidityMode || ''} onChange={(event) => {
                const idValidityMode = event.target.value;
                setEditor((current) => current ? {
                  ...current,
                  record: {
                    ...current.record,
                    idValidityMode,
                    ...(idValidityMode === 'range' ? {} : { idValidFrom: '', idValidTo: '' }),
                  } as CredentialRecord,
                } : current);
              }}><option value="">未设置</option><option value="range">日期范围</option><option value="long-term">长期</option></select></FormField>
              {record.idValidityMode === 'range' ? <><FormField label="身份证有效期开始"><input type="date" value={record.idValidFrom || ''} onChange={(event) => updateEditorRecord('idValidFrom', event.target.value)} /></FormField><FormField label="身份证有效期结束"><input type="date" value={record.idValidTo || ''} onChange={(event) => updateEditorRecord('idValidTo', event.target.value)} /></FormField></> : null}
              <FormField label="学历"><input value={record.education || ''} onChange={(event) => updateEditorRecord('education', event.target.value)} /></FormField>
              <FormField label="学校"><input value={record.school || ''} onChange={(event) => updateEditorRecord('school', event.target.value)} /></FormField>
              <FormField label="专业"><input value={record.major || ''} onChange={(event) => updateEditorRecord('major', event.target.value)} /></FormField>
              <FormField label="人员简介" wide><textarea rows={6} value={record.introduction || ''} onChange={(event) => updateEditorRecord('introduction', event.target.value)} /></FormField>
            </div>
          </section>
          <div className="credential-editor-image-grid">{employeeImageFields.map((item) => renderEditorImageField(item.fieldKey, item.title))}</div>
          {renderEditorImageField('skillCertificate', '技能证书', true)}
        </div>
      );
    }
    if (editor.type === 'project') {
      return (
        <div className="credential-editor-body">
          <section className="credential-editor-section">
            <h3>业绩信息</h3>
            <div className="credential-form-grid">
              <FormField label="项目名称"><input value={record.projectName || ''} onChange={(event) => updateEditorRecord('projectName', event.target.value)} /></FormField>
              <FormField label="项目编号"><input value={record.projectNumber || ''} onChange={(event) => updateEditorRecord('projectNumber', event.target.value)} /></FormField>
              <FormField label="客户名称"><input value={record.customerName || ''} onChange={(event) => updateEditorRecord('customerName', event.target.value)} /></FormField>
              <FormField label="项目类型"><select value={record.projectType || ''} onChange={(event) => updateEditorRecord('projectType', event.target.value)}><option value="">未选择</option><option value="service">服务</option><option value="goods">货物</option><option value="construction">工程</option></select></FormField>
              <FormField label="项目负责人"><input value={record.projectManager || ''} onChange={(event) => updateEditorRecord('projectManager', event.target.value)} /></FormField>
              <FormField label="合同金额"><input value={record.contractAmount || ''} placeholder="如：128.6万元" onChange={(event) => updateEditorRecord('contractAmount', event.target.value)} /></FormField>
              <FormField label="开始日期"><input type="date" value={record.startDate || ''} onChange={(event) => updateEditorRecord('startDate', event.target.value)} /></FormField>
              <FormField label="结束日期"><input type="date" value={record.endDate || ''} onChange={(event) => updateEditorRecord('endDate', event.target.value)} /></FormField>
              <FormField label="项目状态"><input value={record.projectStatus || ''} onChange={(event) => updateEditorRecord('projectStatus', event.target.value)} /></FormField>
              <FormField label="项目介绍" wide><textarea rows={6} value={record.introduction || ''} onChange={(event) => updateEditorRecord('introduction', event.target.value)} /></FormField>
            </div>
          </section>
          <div className="credential-editor-image-grid">{projectImageFields.map((item) => renderEditorImageField(item.fieldKey, item.title))}</div>
        </div>
      );
    }
    return (
      <div className="credential-editor-body">
        <section className="credential-editor-section">
          <div className="credential-form-grid">
            <FormField label="资料名称"><input value={record.name || ''} onChange={(event) => updateEditorRecord('name', event.target.value)} /></FormField>
            <FormField label="备注" wide><textarea rows={6} value={record.note || ''} onChange={(event) => updateEditorRecord('note', event.target.value)} /></FormField>
          </div>
        </section>
        {renderEditorImageField('otherMaterialImages', '资料图片')}
      </div>
    );
  };

  if (loading) {
    return <div className="credential-library-loading"><InlineSpinner /><strong>正在读取资信库...</strong></div>;
  }

  return (
    <div className="credential-library-page">
      <section className="credential-library-shell">
        <header className="bid-analysis-command-bar credential-library-command-bar">
          <div>
            <span className="section-kicker">知识库</span>
            <strong>资信库</strong>
            <p>集中维护一家企业的资信数据和原始图片，所有资料均可按需选择录入。</p>
          </div>
          <div className="credential-library-summary">
            {developerMode ? <button type="button" className="secondary-action" onClick={() => setImportConfirmOpen(true)} disabled={busy !== null}>{busy === 'import-test-data' ? '导入中...' : '导入测试数据'}</button> : null}
            <span>{profile.companyName || '未填写公司名称'}</span>
            <small>{snapshot?.employees.length || 0} 名员工 · {snapshot?.projects.length || 0} 项业绩 · {snapshot?.images.length || 0} 张图片</small>
          </div>
        </header>

        <div className="document-switch-tabs generation-settings-tabs credential-library-tabs" role="tablist" aria-label="资信库分类">
          {tabs.map((tab, index) => {
            const active = activeTab === tab.id;
            return <button type="button" className={`document-switch-tab generation-settings-tab${active ? ' is-active' : ''}`} id={`credential-tab-${tab.id}`} role="tab" aria-selected={active} aria-controls="credential-tab-panel" tabIndex={active ? 0 : -1} key={tab.id} onClick={() => setActiveTab(tab.id)} onKeyDown={(event) => handleTabKeyDown(event, index)}>{tab.label}</button>;
          })}
        </div>

        <div className="credential-library-panel" id="credential-tab-panel" role="tabpanel" aria-labelledby={`credential-tab-${activeTab}`}>
          {activeTab === 'basic' ? renderBasicPanel()
            : activeTab === 'intro' ? renderIntroPanel()
              : activeTab === 'qualification' ? renderQualificationPanel()
                : activeTab === 'employee' ? renderEmployeePanel()
                  : activeTab === 'project' ? renderProjectPanel()
                    : activeTab === 'finance' ? renderFinancePanel()
                      : activeTab === 'other' ? renderOtherPanel()
                        : renderWatermarkPanel()}
        </div>
      </section>

      <AppDialog
        open={importConfirmOpen}
        onOpenChange={(open) => busy === null && setImportConfirmOpen(open)}
        kicker="开发者工具"
        title="完整替换当前资信库？"
        description="继续后请选择包含 credential-library.json 的测试数据文件夹。当前资信文本、记录和工作区原图将被完整替换。"
        preventClose={busy !== null}
        actions={<><button type="button" className="secondary-action" onClick={() => setImportConfirmOpen(false)} disabled={busy !== null}>取消</button><button type="button" className="danger-action" onClick={() => void importTestData()} disabled={busy !== null}>选择文件夹并导入</button></>}
      />

      <AppDialog
        open={Boolean(editor)}
        onOpenChange={(open) => !open && busy === null && closeEditor()}
        kicker={editor?.type === 'employee' ? '员工档案' : editor?.type === 'project' ? '项目业绩' : editor?.type === 'certificate' ? '其他证书' : '其他资料'}
        title={editor ? `${(editor.record as CredentialCertificate).certificateId || (editor.record as CredentialEmployee).employeeId || (editor.record as CredentialProject).projectId || (editor.record as CredentialOtherMaterial).materialId ? '编辑' : '新增'}${editor.type === 'employee' ? '员工' : editor.type === 'project' ? '业绩' : editor.type === 'certificate' ? '证书' : '资料'}` : ''}
        description="所有字段均为选填；新增图片会在保存记录时复制到应用工作区。"
        cardClassName="credential-editor-dialog"
        preventClose={busy !== null}
        actions={<><button type="button" className="secondary-action" onClick={closeEditor} disabled={busy !== null}>取消</button><button type="button" className="primary-action" onClick={() => void saveEditor()} disabled={busy !== null}>{busy?.startsWith('save-') ? '保存中...' : '保存'}</button></>}
      >
        {renderEditorBody()}
      </AppDialog>

      <AppDialog
        open={Boolean(pendingDelete)}
        onOpenChange={(open) => !open && busy === null && setPendingDelete(null)}
        kicker="永久删除"
        title={`删除“${pendingDelete?.label || ''}”？`}
        description={pendingDelete?.kind === 'image' ? '删除后会同时移除工作区中的原始图片，无法恢复。' : '删除后会同时移除该记录的全部原始图片，无法恢复。'}
        preventClose={busy !== null}
        actions={<><button type="button" className="secondary-action" onClick={() => setPendingDelete(null)} disabled={busy !== null}>取消</button><button type="button" className="danger-action" onClick={() => void confirmDelete()} disabled={busy !== null}>{busy?.startsWith('delete-') ? '删除中...' : '删除'}</button></>}
      />
    </div>
  );
}

export default CredentialLibraryPage;
