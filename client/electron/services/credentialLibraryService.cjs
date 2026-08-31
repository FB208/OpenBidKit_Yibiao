const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { getCredentialLibraryDir } = require('../utils/paths.cjs');

const PROFILE_ID = '1';
const TEST_IMPORT_FILE_NAME = 'credential-library.json';
const supportedImageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif']);
const importImageFieldKeys = {
  profile: new Set([
    'officeEnvironment',
    'businessLicense',
    'legalRepresentativeIdEmblem',
    'legalRepresentativeIdPortrait',
    'legalRepresentativeAuthorization',
    'authorizedRepresentativeIdEmblem',
    'authorizedRepresentativeIdPortrait',
    'basicDepositAccountInfo',
    'creditChinaReport',
    'governmentProcurementRecord',
    'enterpriseCreditReport',
    'dishonestEnforcementQuery',
    'taxCertificate',
    'auditReport',
    'socialSecurityCertificate',
    'bankAccountLicense',
  ]),
  certificate: new Set(['certificateImages']),
  employee: new Set([
    'employeeSocialSecurity',
    'employeeIdEmblem',
    'employeeIdPortrait',
    'laborContract',
    'educationCertificate',
    'driverLicense',
    'skillCertificate',
  ]),
  project: new Set(['projectContract', 'bidWinningNotice', 'projectAcceptanceCertificate', 'paymentInvoice']),
  other: new Set(['otherMaterialImages']),
};

const profileFieldColumns = {
  companyName: 'company_name',
  unifiedSocialCreditCode: 'unified_social_credit_code',
  phone: 'phone',
  email: 'email',
  legalRepresentative: 'legal_representative',
  registeredCapital: 'registered_capital',
  operatingPeriodStart: 'operating_period_start',
  operatingPeriodEnd: 'operating_period_end',
  address: 'address',
  businessScope: 'business_scope',
  industry: 'industry',
  companyType: 'company_type',
  insuredEmployeeCount: 'insured_employee_count',
  companyIntro: 'company_intro',
  taxCertificateDate: 'tax_certificate_date',
  taxCertificateNote: 'tax_certificate_note',
  auditReportDate: 'audit_report_date',
  auditReportNote: 'audit_report_note',
  socialSecurityCertificateDate: 'social_security_certificate_date',
  socialSecurityCertificateNote: 'social_security_certificate_note',
  bankAccountName: 'bank_account_name',
  bankAccountNumber: 'bank_account_number',
  bankName: 'bank_name',
  bankRoutingNumber: 'bank_routing_number',
  watermarkEnabled: 'watermark_enabled',
  watermarkContent: 'watermark_content',
};

const recordConfigs = {
  certificate: {
    table: 'credential_library_certificates',
    idColumn: 'certificate_id',
    idProperty: 'certificateId',
    prefix: 'cert',
    fields: {
      name: 'name',
      number: 'number',
      validityMode: 'validity_mode',
      validFrom: 'valid_from',
      validTo: 'valid_to',
    },
  },
  employee: {
    table: 'credential_library_employees',
    idColumn: 'employee_id',
    idProperty: 'employeeId',
    prefix: 'employee',
    fields: {
      name: 'name',
      idNumber: 'id_number',
      position: 'position',
      professionalTitle: 'professional_title',
      gender: 'gender',
      phone: 'phone',
      idValidityMode: 'id_validity_mode',
      idValidFrom: 'id_valid_from',
      idValidTo: 'id_valid_to',
      education: 'education',
      school: 'school',
      major: 'major',
      introduction: 'introduction',
    },
  },
  project: {
    table: 'credential_library_projects',
    idColumn: 'project_id',
    idProperty: 'projectId',
    prefix: 'project',
    fields: {
      projectName: 'project_name',
      projectNumber: 'project_number',
      customerName: 'customer_name',
      projectType: 'project_type',
      projectManager: 'project_manager',
      contractAmount: 'contract_amount',
      startDate: 'start_date',
      endDate: 'end_date',
      projectStatus: 'project_status',
      introduction: 'introduction',
    },
  },
  other: {
    table: 'credential_library_other_materials',
    idColumn: 'material_id',
    idProperty: 'materialId',
    prefix: 'material',
    fields: {
      name: 'name',
      note: 'note',
    },
  },
};

/** 读取并解析所选目录中的资信库测试数据文件。 */
function readTestImportConfig(folderPath) {
  const selectedFolderPath = text(folderPath).trim();
  if (!selectedFolderPath) throw new Error('请选择测试数据文件夹');
  const normalizedFolderPath = path.resolve(selectedFolderPath);
  if (!fs.existsSync(normalizedFolderPath) || !fs.statSync(normalizedFolderPath).isDirectory()) {
    throw new Error('所选测试数据文件夹不存在');
  }
  const configPath = path.join(normalizedFolderPath, TEST_IMPORT_FILE_NAME);
  if (!fs.existsSync(configPath)) {
    throw new Error(`所选文件夹缺少 ${TEST_IMPORT_FILE_NAME}`);
  }
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('根节点必须是对象');
    const allowedRootKeys = new Set(['profile', 'certificates', 'employees', 'projects', 'otherMaterials']);
    const unknownKey = Object.keys(config).find((key) => !allowedRootKeys.has(key));
    if (unknownKey) throw new Error(`存在未知根字段：${unknownKey}`);
    return { folderPath: normalizedFolderPath, config };
  } catch (error) {
    throw new Error(`读取 ${TEST_IMPORT_FILE_NAME} 失败：${error?.message || String(error)}`);
  }
}

/** 将 JSON 中的一组图片相对路径转换为可复制的图片项。 */
function normalizeImportImages(folderPath, imageGroups, ownerType, label) {
  if (imageGroups === undefined) return [];
  if (!imageGroups || typeof imageGroups !== 'object' || Array.isArray(imageGroups)) {
    throw new Error(`${label}.images 必须是对象`);
  }
  const additions = [];
  for (const [fieldKey, entries] of Object.entries(imageGroups)) {
    if (!importImageFieldKeys[ownerType].has(fieldKey)) {
      throw new Error(`${label}.images 包含未知图片栏目：${fieldKey}`);
    }
    if (!Array.isArray(entries)) throw new Error(`${label}.images.${fieldKey} 必须是数组`);
    entries.forEach((entry, index) => {
      const itemLabel = `${label}.images.${fieldKey}[${index}]`;
      if (typeof entry !== 'string' && (!entry || typeof entry !== 'object' || Array.isArray(entry))) {
        throw new Error(`${itemLabel} 必须是相对路径或图片对象`);
      }
      if (typeof entry !== 'string') {
        const unknownKey = Object.keys(entry).find((key) => !['path', 'customName'].includes(key));
        if (unknownKey) throw new Error(`${itemLabel} 包含未知字段：${unknownKey}`);
      }
      const relativePath = text(typeof entry === 'string' ? entry : entry.path).trim();
      if (!relativePath || path.isAbsolute(relativePath)) throw new Error(`${itemLabel} 必须填写文件夹内的相对路径`);
      const filePath = path.resolve(folderPath, relativePath);
      const pathFromRoot = path.relative(folderPath, filePath);
      if (!pathFromRoot || pathFromRoot.startsWith('..') || path.isAbsolute(pathFromRoot)) {
        throw new Error(`${itemLabel} 不能指向所选文件夹之外`);
      }
      const extension = path.extname(filePath).toLowerCase();
      if (!supportedImageExtensions.has(extension)) throw new Error(`${itemLabel} 不是支持的图片格式`);
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) throw new Error(`${itemLabel} 对应图片不存在`);
      additions.push({
        fieldKey,
        filePath,
        customName: text(typeof entry === 'string' ? '' : entry.customName),
      });
    });
  }
  return additions;
}

/** 规范化一条测试记录，并拒绝容易被忽略的字段拼写错误。 */
function normalizeImportEntity(folderPath, value, ownerType, label, allowedFields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是对象`);
  const allowedKeys = new Set([...allowedFields, 'images']);
  const unknownKey = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknownKey) throw new Error(`${label} 包含未知字段：${unknownKey}`);
  const record = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'images'));
  return {
    record,
    images: normalizeImportImages(folderPath, value.images, ownerType, label),
  };
}

/** 规范化测试数据文件中的完整资信库内容。 */
function normalizeTestImportData(folderPath, config) {
  const profileEntity = normalizeImportEntity(folderPath, config.profile || {}, 'profile', 'profile', Object.keys(profileFieldColumns));
  if (Object.prototype.hasOwnProperty.call(profileEntity.record, 'watermarkEnabled') && typeof profileEntity.record.watermarkEnabled !== 'boolean') {
    throw new Error('profile.watermarkEnabled 必须是 true 或 false');
  }
  const listConfigs = [
    ['certificates', 'certificate', '其他证书'],
    ['employees', 'employee', '员工'],
    ['projects', 'project', '业绩'],
    ['otherMaterials', 'other', '其他资料'],
  ];
  const data = { profile: profileEntity.record, profileImages: profileEntity.images };
  for (const [property, ownerType, label] of listConfigs) {
    const values = config[property] === undefined ? [] : config[property];
    if (!Array.isArray(values)) throw new Error(`${property} 必须是数组`);
    data[property] = values.map((value, index) => normalizeImportEntity(
      folderPath,
      value,
      ownerType,
      `${label}[${index}]`,
      Object.keys(recordConfigs[ownerType].fields),
    ));
  }
  for (const [index, item] of data.certificates.entries()) {
    const mode = text(item.record.validityMode);
    if (!['', 'range', 'long-term'].includes(mode)) throw new Error(`其他证书[${index}].validityMode 无效`);
    if (mode !== 'range') Object.assign(item.record, { validFrom: '', validTo: '' });
  }
  for (const [index, item] of data.employees.entries()) {
    const mode = text(item.record.idValidityMode);
    if (!['', 'range', 'long-term'].includes(mode)) throw new Error(`员工[${index}].idValidityMode 无效`);
    if (mode !== 'range') Object.assign(item.record, { idValidFrom: '', idValidTo: '' });
  }
  for (const [index, item] of data.projects.entries()) {
    if (!['', 'service', 'goods', 'construction'].includes(text(item.record.projectType))) {
      throw new Error(`业绩[${index}].projectType 无效`);
    }
  }
  return data;
}

/** 返回当前时间的稳定存储格式。 */
function now() {
  return new Date().toISOString();
}

/** 把可选表单值统一保存为字符串。 */
function text(value) {
  return value == null ? '' : String(value);
}

/** 生成业务记录主键。 */
function createId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

/** 将相对路径转换为资信库本地资源地址。 */
function buildAssetUrl(relativePath) {
  const encodedPath = String(relativePath || '').split('/').filter(Boolean).map(encodeURIComponent).join('/');
  return `yibiao-asset://credential-library/${encodedPath}`;
}

/** 把数据库图片行转换为 Renderer 使用的结构。 */
function imageFromRow(row) {
  return {
    imageId: row.image_id,
    ownerType: row.owner_type,
    ownerId: row.owner_id,
    fieldKey: row.field_key,
    originalName: row.original_name,
    relativePath: row.relative_path,
    assetUrl: buildAssetUrl(row.relative_path),
    customName: row.custom_name || '',
    sortOrder: row.sort_order,
    createdAt: row.created_at,
  };
}

/** 把企业单例行转换为完整的可编辑资料。 */
function profileFromRow(row) {
  return {
    companyName: row?.company_name || '',
    unifiedSocialCreditCode: row?.unified_social_credit_code || '',
    phone: row?.phone || '',
    email: row?.email || '',
    legalRepresentative: row?.legal_representative || '',
    registeredCapital: row?.registered_capital || '',
    operatingPeriodStart: row?.operating_period_start || '',
    operatingPeriodEnd: row?.operating_period_end || '',
    address: row?.address || '',
    businessScope: row?.business_scope || '',
    industry: row?.industry || '',
    companyType: row?.company_type || '',
    insuredEmployeeCount: row?.insured_employee_count || '',
    companyIntro: row?.company_intro || '',
    taxCertificateDate: row?.tax_certificate_date || '',
    taxCertificateNote: row?.tax_certificate_note || '',
    auditReportDate: row?.audit_report_date || '',
    auditReportNote: row?.audit_report_note || '',
    socialSecurityCertificateDate: row?.social_security_certificate_date || '',
    socialSecurityCertificateNote: row?.social_security_certificate_note || '',
    bankAccountName: row?.bank_account_name || '',
    bankAccountNumber: row?.bank_account_number || '',
    bankName: row?.bank_name || '',
    bankRoutingNumber: row?.bank_routing_number || '',
    watermarkEnabled: Boolean(row?.watermark_enabled),
    watermarkContent: row?.watermark_content || '',
    createdAt: row?.created_at || '',
    updatedAt: row?.updated_at || '',
  };
}

/** 把其他证书行转换为业务结构。 */
function certificateFromRow(row) {
  return {
    certificateId: row.certificate_id,
    name: row.name || '',
    number: row.number || '',
    validityMode: row.validity_mode || '',
    validFrom: row.valid_from || '',
    validTo: row.valid_to || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 把员工行转换为业务结构。 */
function employeeFromRow(row) {
  return {
    employeeId: row.employee_id,
    name: row.name || '',
    idNumber: row.id_number || '',
    position: row.position || '',
    professionalTitle: row.professional_title || '',
    gender: row.gender || '',
    phone: row.phone || '',
    idValidityMode: row.id_validity_mode || '',
    idValidFrom: row.id_valid_from || '',
    idValidTo: row.id_valid_to || '',
    education: row.education || '',
    school: row.school || '',
    major: row.major || '',
    introduction: row.introduction || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 把业绩行转换为业务结构。 */
function projectFromRow(row) {
  return {
    projectId: row.project_id,
    projectName: row.project_name || '',
    projectNumber: row.project_number || '',
    customerName: row.customer_name || '',
    projectType: row.project_type || '',
    projectManager: row.project_manager || '',
    contractAmount: row.contract_amount || '',
    startDate: row.start_date || '',
    endDate: row.end_date || '',
    projectStatus: row.project_status || '',
    introduction: row.introduction || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 把其他资料行转换为业务结构。 */
function otherMaterialFromRow(row) {
  return {
    materialId: row.material_id,
    name: row.name || '',
    note: row.note || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 创建资信库数据库与原图文件服务。 */
function createCredentialLibraryService({ app, db }) {
  const rootDir = getCredentialLibraryDir(app);
  const imagesDir = path.join(rootDir, 'images');

  /** 读取资信库完整快照。 */
  function load() {
    return {
      profile: profileFromRow(db.prepare('SELECT * FROM credential_library_profile WHERE id = 1').get()),
      certificates: db.prepare('SELECT * FROM credential_library_certificates ORDER BY updated_at DESC, created_at DESC').all().map(certificateFromRow),
      employees: db.prepare('SELECT * FROM credential_library_employees ORDER BY updated_at DESC, created_at DESC').all().map(employeeFromRow),
      projects: db.prepare('SELECT * FROM credential_library_projects ORDER BY updated_at DESC, created_at DESC').all().map(projectFromRow),
      otherMaterials: db.prepare('SELECT * FROM credential_library_other_materials ORDER BY updated_at DESC, created_at DESC').all().map(otherMaterialFromRow),
      images: db.prepare('SELECT * FROM credential_library_images ORDER BY owner_type, owner_id, field_key, sort_order, created_at').all().map(imageFromRow),
    };
  }

  /** 将数据库相对路径解析到资信库目录内。 */
  function resolveStoredPath(relativePath) {
    return path.join(rootDir, ...String(relativePath || '').split('/').filter(Boolean));
  }

  /** 清理已从数据库移除的原图文件。 */
  function removeStoredFiles(rows) {
    const failures = [];
    for (const row of rows) {
      try {
        fs.rmSync(resolveStoredPath(row.relative_path), { force: true });
      } catch (error) {
        failures.push(row.original_name || row.relative_path);
        console.warn('[credential-library] 删除原图失败', row.relative_path, error?.message || String(error));
      }
    }
    return failures;
  }

  /** 校验并复制一组新增原图，失败时回收已复制文件。 */
  function copyNewImages(ownerType, ownerId, additions) {
    const copied = [];
    fs.mkdirSync(imagesDir, { recursive: true });

    try {
      for (const addition of Array.isArray(additions) ? additions : []) {
        const filePath = text(addition?.filePath).trim();
        const fieldKey = text(addition?.fieldKey).trim();
        if (!filePath || !fieldKey) continue;

        const extension = path.extname(filePath).toLowerCase();
        if (!supportedImageExtensions.has(extension)) {
          throw new Error(`不支持的图片格式：${path.basename(filePath)}`);
        }
        if (!fs.statSync(filePath).isFile()) {
          throw new Error(`图片文件不存在：${path.basename(filePath)}`);
        }

        const imageId = createId('image');
        const storedName = `${crypto.randomUUID()}${extension}`;
        const relativePath = `images/${storedName}`;
        const nextOrder = Number(db.prepare(`
          SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order
          FROM credential_library_images
          WHERE owner_type = ? AND owner_id = ? AND field_key = ?
        `).get(ownerType, ownerId, fieldKey)?.next_order || 0) + copied.filter((item) => item.field_key === fieldKey).length;
        fs.copyFileSync(filePath, path.join(imagesDir, storedName));
        copied.push({
          image_id: imageId,
          owner_type: ownerType,
          owner_id: ownerId,
          field_key: fieldKey,
          original_name: path.basename(filePath),
          relative_path: relativePath,
          custom_name: text(addition?.customName),
          sort_order: nextOrder,
          created_at: now(),
        });
      }
      return copied;
    } catch (error) {
      removeStoredFiles(copied);
      throw error;
    }
  }

  /** 写入已复制图片的数据库索引。 */
  function insertCopiedImages(copied) {
    const insert = db.prepare(`
      INSERT INTO credential_library_images (
        image_id, owner_type, owner_id, field_key, original_name,
        relative_path, custom_name, sort_order, created_at
      ) VALUES (
        @image_id, @owner_type, @owner_id, @field_key, @original_name,
        @relative_path, @custom_name, @sort_order, @created_at
      )
    `);
    copied.forEach((item) => insert.run(item));
  }

  /** 写入企业单例字段，供普通保存和测试数据导入共用。 */
  function writeProfile(partial, timestamp = now()) {
    db.prepare(`
      INSERT OR IGNORE INTO credential_library_profile (id, created_at, updated_at)
      VALUES (1, ?, ?)
    `).run(timestamp, timestamp);

    const entries = Object.entries(profileFieldColumns).filter(([property]) => Object.prototype.hasOwnProperty.call(partial || {}, property));
    if (entries.length) {
      const values = { updated_at: timestamp };
      const assignments = entries.map(([property, column]) => {
        values[column] = property === 'watermarkEnabled' ? (partial[property] ? 1 : 0) : text(partial[property]);
        return `${column} = @${column}`;
      });
      db.prepare(`UPDATE credential_library_profile SET ${assignments.join(', ')}, updated_at = @updated_at WHERE id = 1`).run(values);
    }
  }

  /** 按 patch 保存企业单例字段。 */
  function saveProfile(partial) {
    writeProfile(partial);
    return load();
  }

  /** 为企业单例资料追加多张原图。 */
  function addProfileImages(fieldKey, filePaths) {
    const additions = (Array.isArray(filePaths) ? filePaths : []).map((filePath) => ({ fieldKey, filePath }));
    const copied = copyNewImages('profile', PROFILE_ID, additions);
    try {
      db.transaction(() => insertCopiedImages(copied))();
    } catch (error) {
      removeStoredFiles(copied);
      throw error;
    }
    return load();
  }

  /** 将一条已规范化的测试记录写入对应业务表。 */
  function insertImportedRecord(ownerType, record, recordId, timestamp) {
    const config = recordConfigs[ownerType];
    const values = {
      [config.idColumn]: recordId,
      created_at: timestamp,
      updated_at: timestamp,
    };
    for (const [property, column] of Object.entries(config.fields)) {
      values[column] = text(record[property]);
    }
    const columns = [config.idColumn, ...Object.values(config.fields), 'created_at', 'updated_at'];
    db.prepare(`
      INSERT INTO ${config.table} (${columns.join(', ')})
      VALUES (${columns.map((column) => `@${column}`).join(', ')})
    `).run(values);
  }

  /** 从开发者测试目录完整替换资信库文本、记录和原图。 */
  function importTestData(folderPath) {
    const { folderPath: normalizedFolderPath, config } = readTestImportConfig(folderPath);
    const data = normalizeTestImportData(normalizedFolderPath, config);
    const importedRecords = [
      ...data.certificates.map((item) => ({ ...item, ownerType: 'certificate', recordId: createId(recordConfigs.certificate.prefix) })),
      ...data.employees.map((item) => ({ ...item, ownerType: 'employee', recordId: createId(recordConfigs.employee.prefix) })),
      ...data.projects.map((item) => ({ ...item, ownerType: 'project', recordId: createId(recordConfigs.project.prefix) })),
      ...data.otherMaterials.map((item) => ({ ...item, ownerType: 'other', recordId: createId(recordConfigs.other.prefix) })),
    ];
    const copied = [];
    try {
      copied.push(...copyNewImages('profile', PROFILE_ID, data.profileImages));
      for (const item of importedRecords) {
        copied.push(...copyNewImages(item.ownerType, item.recordId, item.images));
      }
    } catch (error) {
      removeStoredFiles(copied);
      throw error;
    }

    const oldImageRows = db.prepare('SELECT * FROM credential_library_images').all();
    const timestamp = now();
    try {
      db.transaction(() => {
        db.prepare('DELETE FROM credential_library_images').run();
        db.prepare('DELETE FROM credential_library_certificates').run();
        db.prepare('DELETE FROM credential_library_employees').run();
        db.prepare('DELETE FROM credential_library_projects').run();
        db.prepare('DELETE FROM credential_library_other_materials').run();
        db.prepare('DELETE FROM credential_library_profile').run();
        writeProfile(data.profile, timestamp);
        importedRecords.forEach((item) => insertImportedRecord(item.ownerType, item.record, item.recordId, timestamp));
        insertCopiedImages(copied);
      })();
    } catch (error) {
      removeStoredFiles(copied);
      throw error;
    }

    return {
      snapshot: load(),
      fileDeleteFailures: removeStoredFiles(oldImageRows),
      counts: {
        certificates: data.certificates.length,
        employees: data.employees.length,
        projects: data.projects.length,
        otherMaterials: data.otherMaterials.length,
        images: copied.length,
      },
    };
  }

  /** 新增或更新一条列表记录，并一次提交其图片变更。 */
  function saveRecord(ownerType, payload) {
    const config = recordConfigs[ownerType];
    const record = payload?.record || {};
    const recordId = text(record[config.idProperty]).trim() || createId(config.prefix);
    const timestamp = now();
    const removedIds = [...new Set((payload?.removedImageIds || []).map((item) => text(item).trim()).filter(Boolean))];
    const removedRows = removedIds.length
      ? db.prepare(`SELECT * FROM credential_library_images WHERE owner_type = ? AND owner_id = ? AND image_id IN (${removedIds.map(() => '?').join(', ')})`).all(ownerType, recordId, ...removedIds)
      : [];
    const copied = copyNewImages(ownerType, recordId, payload?.newImages);

    const values = {
      [config.idColumn]: recordId,
      created_at: timestamp,
      updated_at: timestamp,
    };
    for (const [property, column] of Object.entries(config.fields)) {
      values[column] = text(record[property]);
    }
    const columns = [config.idColumn, ...Object.values(config.fields), 'created_at', 'updated_at'];
    const updates = [...Object.values(config.fields), 'updated_at'].map((column) => `${column} = excluded.${column}`);

    try {
      db.transaction(() => {
        db.prepare(`
          INSERT INTO ${config.table} (${columns.join(', ')})
          VALUES (${columns.map((column) => `@${column}`).join(', ')})
          ON CONFLICT(${config.idColumn}) DO UPDATE SET ${updates.join(', ')}
        `).run(values);

        if (removedRows.length) {
          db.prepare(`DELETE FROM credential_library_images WHERE owner_type = ? AND owner_id = ? AND image_id IN (${removedRows.map(() => '?').join(', ')})`)
            .run(ownerType, recordId, ...removedRows.map((item) => item.image_id));
        }
        for (const update of Array.isArray(payload?.imageNameUpdates) ? payload.imageNameUpdates : []) {
          db.prepare(`
            UPDATE credential_library_images
            SET custom_name = ?
            WHERE image_id = ? AND owner_type = ? AND owner_id = ?
          `).run(text(update?.customName), text(update?.imageId), ownerType, recordId);
        }
        insertCopiedImages(copied);
      })();
    } catch (error) {
      removeStoredFiles(copied);
      throw error;
    }

    return {
      snapshot: load(),
      fileDeleteFailures: removeStoredFiles(removedRows),
    };
  }

  /** 删除一条列表记录及其全部原图。 */
  function deleteRecord(ownerType, recordId) {
    const config = recordConfigs[ownerType];
    const normalizedId = text(recordId).trim();
    const imageRows = db.prepare('SELECT * FROM credential_library_images WHERE owner_type = ? AND owner_id = ?').all(ownerType, normalizedId);
    db.transaction(() => {
      db.prepare('DELETE FROM credential_library_images WHERE owner_type = ? AND owner_id = ?').run(ownerType, normalizedId);
      db.prepare(`DELETE FROM ${config.table} WHERE ${config.idColumn} = ?`).run(normalizedId);
    })();
    return {
      snapshot: load(),
      fileDeleteFailures: removeStoredFiles(imageRows),
    };
  }

  /** 删除单张图片及其数据库索引。 */
  function deleteImage(imageId) {
    const row = db.prepare('SELECT * FROM credential_library_images WHERE image_id = ?').get(text(imageId));
    let fileDeleteFailures = [];
    if (row) {
      db.prepare('DELETE FROM credential_library_images WHERE image_id = ?').run(row.image_id);
      fileDeleteFailures = removeStoredFiles([row]);
    }
    return {
      snapshot: load(),
      fileDeleteFailures,
    };
  }

  return {
    load,
    importTestData,
    saveProfile,
    addProfileImages,
    deleteImage,
    saveCertificate: (payload) => saveRecord('certificate', payload),
    deleteCertificate: (recordId) => deleteRecord('certificate', recordId),
    saveEmployee: (payload) => saveRecord('employee', payload),
    deleteEmployee: (recordId) => deleteRecord('employee', recordId),
    saveProject: (payload) => saveRecord('project', payload),
    deleteProject: (recordId) => deleteRecord('project', recordId),
    saveOtherMaterial: (payload) => saveRecord('other', payload),
    deleteOtherMaterial: (recordId) => deleteRecord('other', recordId),
  };
}

module.exports = {
  createCredentialLibraryService,
};
