// 默认政策参数 — 首次启动时写入 data/policy.json
module.exports = {
  current: {
    version: "估算参数 V1.2 · 2026-07-29",
    enabledAt: "2026-07-29T00:00:00+08:00",
    source: "预置估算值。失业保险为阶段性降率，请核实当期是否延续。工伤保险按行业风险分八档。",
    params: {
      minimumWage: 2080,
      localAvgSalary: 8500,
      pensionMin: 4775, pensionMax: 27549, pensionEmployer: 16, pensionEmployee: 8,
      medicalMin: 4775, medicalMax: 27549, medicalEmployer: 6, medicalEmployee: 1.5,
      medicalTier2Employer: 3, medicalTier2Employee: 0,
      unemploymentMin: 2080, unemploymentMax: 27549, unemploymentEmployer: 0.8, unemploymentEmployee: 0.2,
      injuryMin: 2080, injuryMax: 27549, injuryEmployer: 0.4,
      fundMin: 2080, fundMax: 34926, fundEmployer: 5, fundEmployee: 5
    }
  },
  drafts: [],
  history: [],
  syncLog: []
};
