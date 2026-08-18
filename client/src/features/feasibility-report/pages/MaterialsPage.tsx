import type { FeasibilityProjectInfo, FeasibilityProjectType } from '../types';
import { DEFAULT_FEASIBILITY_PROJECT_INFO } from '../types';

interface MaterialsPageProps {
  projectInfo: FeasibilityProjectInfo;
  onProjectInfoChange: (projectInfo: FeasibilityProjectInfo) => void;
}

function MaterialsPage({ projectInfo, onProjectInfoChange }: MaterialsPageProps) {
  const draft = { ...DEFAULT_FEASIBILITY_PROJECT_INFO, ...projectInfo };

  const updateField = <K extends keyof FeasibilityProjectInfo>(key: K, value: FeasibilityProjectInfo[K]) => {
    onProjectInfoChange({ ...draft, [key]: value });
  };

  return (
    <div className="plan-step-body feasibility-materials-page">
      <section className="panel feasibility-project-form">
        <div>
          <span className="section-kicker">STEP 01</span>
          <h3>项目资料</h3>
          <p>先填写项目基础参数。本阶段不计算 NPV、IRR 或投资回收期。下一步可按需补充资料文件，不是必填。</p>
        </div>
        <div className="feasibility-form-grid">
          <label>
            <span>项目名称 *</span>
            <input value={draft.projectName} onChange={(event) => updateField('projectName', event.target.value)} placeholder="例如：某某产业园一期工程" />
          </label>
          <label>
            <span>项目类型</span>
            <select value={draft.projectType} onChange={(event) => updateField('projectType', event.target.value as FeasibilityProjectType)}>
              <option value="government">政府投资</option>
              <option value="enterprise">企业投资</option>
            </select>
          </label>
          <label>
            <span>所属行业</span>
            <input value={draft.industry} onChange={(event) => updateField('industry', event.target.value)} />
          </label>
          <label>
            <span>建设单位</span>
            <input value={draft.constructionUnit} onChange={(event) => updateField('constructionUnit', event.target.value)} />
          </label>
          <label>
            <span>建设地点</span>
            <input value={draft.location} onChange={(event) => updateField('location', event.target.value)} />
          </label>
          <label>
            <span>总投资</span>
            <input value={draft.totalInvestment} onChange={(event) => updateField('totalInvestment', event.target.value)} placeholder="已知则填写，未知可留空" />
          </label>
          <label>
            <span>建设期（年）</span>
            <input value={draft.constructionPeriodYears} onChange={(event) => updateField('constructionPeriodYears', event.target.value)} />
          </label>
          <label>
            <span>运营期（年）</span>
            <input value={draft.operationPeriodYears} onChange={(event) => updateField('operationPeriodYears', event.target.value)} />
          </label>
          <label className="is-wide">
            <span>资金来源</span>
            <input value={draft.fundingSource} onChange={(event) => updateField('fundingSource', event.target.value)} />
          </label>
          <label className="is-wide">
            <span>建设内容与规模</span>
            <textarea value={draft.constructionContent} onChange={(event) => updateField('constructionContent', event.target.value)} rows={6} />
          </label>
        </div>
      </section>
    </div>
  );
}

export default MaterialsPage;
