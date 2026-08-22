/**
 * Sequelize Model Loader
 */

const { Sequelize } = require('sequelize');
const config = require('../config/database');
const logger = require('../utils/logger');

const env = process.env.NODE_ENV || 'development';
const dbConfig = config[env];

// Create Sequelize instance
const sequelize = new Sequelize(dbConfig.database, dbConfig.username, dbConfig.password, {
  host: dbConfig.host,
  port: dbConfig.port,
  dialect: dbConfig.dialect,
  logging: dbConfig.logging ? (msg) => logger.debug(msg) : false,
  pool: dbConfig.pool,
  dialectOptions: dbConfig.dialectOptions
});

// Import models
const User = require('./User')(sequelize);
const Team = require('./Team')(sequelize);
const UserTeam = require('./UserTeam')(sequelize);
const Submission = require('./Submission')(sequelize);
const File = require('./File')(sequelize);
const KRTData = require('./KRTData')(sequelize);
const ValidationResult = require('./ValidationResult')(sequelize);
const ChangeLog = require('./ChangeLog')(sequelize);
const Report = require('./Report')(sequelize);
const UserHiddenSubmission = require('./UserHiddenSubmission')(sequelize);
const ResourceType = require('./ResourceType')(sequelize);
const AppConfig = require('./AppConfig')(sequelize);
const SubmissionJob = require('./SubmissionJob')(sequelize);
const StepExecution = require('./StepExecution')(sequelize);
const PipelineRun = require('./PipelineRun')(sequelize);
const PipelineRunStep = require('./PipelineRunStep')(sequelize);
const SubmissionInputFreeze = require('./SubmissionInputFreeze')(sequelize);
const EnrichmentListEntry = require('./EnrichmentListEntry')(sequelize);
const RefreshToken = require('./RefreshToken')(sequelize);
const RejectedResource = require('./RejectedResource')(sequelize);
const TeamEmail = require('./TeamEmail')(sequelize);
const Project = require('./Project')(sequelize);

// Define associations
// User -> UserTeams (one-to-many for multi-team support)
User.hasMany(UserTeam, { foreignKey: 'userId', as: 'userTeams' });
UserTeam.belongsTo(User, { foreignKey: 'userId', as: 'user' });

// Team -> UserTeams (one-to-many)
Team.hasMany(UserTeam, { foreignKey: 'team', sourceKey: 'code', as: 'userTeams' });
UserTeam.belongsTo(Team, { foreignKey: 'team', targetKey: 'code', as: 'team_info' });

// Team -> TeamEmails (one-to-many, admin-managed email→team roster)
Team.hasMany(TeamEmail, { foreignKey: 'team', sourceKey: 'code', as: 'teamEmails' });
TeamEmail.belongsTo(Team, { foreignKey: 'team', targetKey: 'code', as: 'team_info' });

// User -> Submissions (one-to-many)
User.hasMany(Submission, { foreignKey: 'userId', as: 'submissions' });
Submission.belongsTo(User, { foreignKey: 'userId', as: 'user' });

// User -> ChangeLogs (one-to-many)
User.hasMany(ChangeLog, { foreignKey: 'userId', as: 'changeLogs' });
ChangeLog.belongsTo(User, { foreignKey: 'userId', as: 'user' });
StepExecution.hasMany(ChangeLog, { foreignKey: 'stepExecutionId', as: 'applies' });
ChangeLog.belongsTo(StepExecution, { foreignKey: 'stepExecutionId', as: 'stepExecution' });

// Submission -> Files (one-to-many)
Submission.hasMany(File, { foreignKey: 'submissionId', as: 'files' });
File.belongsTo(Submission, { foreignKey: 'submissionId', as: 'submission' });

// Submission -> KRTData (one-to-many)
Submission.hasMany(KRTData, { foreignKey: 'submissionId', as: 'krtData' });
KRTData.belongsTo(Submission, { foreignKey: 'submissionId', as: 'submission' });

// KRTData self-referential (origin row tracking for round copies)
KRTData.belongsTo(KRTData, { foreignKey: 'originRowId', as: 'originRow' });
KRTData.hasMany(KRTData, { foreignKey: 'originRowId', as: 'copies' });

// Submission -> ValidationResults (one-to-many)
Submission.hasMany(ValidationResult, { foreignKey: 'submissionId', as: 'validationResults' });
ValidationResult.belongsTo(Submission, { foreignKey: 'submissionId', as: 'submission' });

// KRTData -> ValidationResults (one-to-many)
KRTData.hasMany(ValidationResult, { foreignKey: 'rowId', as: 'validationResults' });
ValidationResult.belongsTo(KRTData, { foreignKey: 'rowId', as: 'krtRow' });

// Submission -> ChangeLogs (one-to-many)
Submission.hasMany(ChangeLog, { foreignKey: 'submissionId', as: 'changeLogs' });
ChangeLog.belongsTo(Submission, { foreignKey: 'submissionId', as: 'submission' });

// Submission -> Reports (one-to-many)
Submission.hasMany(Report, { foreignKey: 'submissionId', as: 'reports' });
Report.belongsTo(Submission, { foreignKey: 'submissionId', as: 'submission' });

// Submission -> SubmissionJobs (one-to-many)
Submission.hasMany(SubmissionJob, { foreignKey: 'submissionId', as: 'jobs' });
SubmissionJob.belongsTo(Submission, { foreignKey: 'submissionId', as: 'submission' });

// User -> SubmissionJobs they triggered. Distinct from submission ownership:
// the person who re-runs a detector is often not the person who owns the
// manuscript.
User.hasMany(SubmissionJob, { foreignKey: 'triggeredByUserId', as: 'triggeredJobs' });
SubmissionJob.belongsTo(User, { foreignKey: 'triggeredByUserId', as: 'triggeredBy' });

// SubmissionJob -> its history. The job row is the CURRENT run; these are every
// run that has ever been started, including the ones that produced nothing.
SubmissionJob.hasMany(StepExecution, { foreignKey: 'submissionJobId', as: 'runs' });
StepExecution.belongsTo(SubmissionJob, { foreignKey: 'submissionJobId', as: 'job' });
Submission.hasMany(StepExecution, { foreignKey: 'submissionId', as: 'jobRuns' });
StepExecution.belongsTo(Submission, { foreignKey: 'submissionId', as: 'submission' });
User.hasMany(StepExecution, { foreignKey: 'triggeredByUserId', as: 'triggeredRuns' });
StepExecution.belongsTo(User, { foreignKey: 'triggeredByUserId', as: 'triggeredBy' });
User.hasMany(StepExecution, { foreignKey: 'cancelledByUserId', as: 'cancelledExecutions' });
StepExecution.belongsTo(User, { foreignKey: 'cancelledByUserId', as: 'cancelledBy' });

// Submission -> PipelineRuns, and a run's own lineage.
Submission.hasMany(PipelineRun, { foreignKey: 'submissionId', as: 'pipelineRuns' });
PipelineRun.belongsTo(Submission, { foreignKey: 'submissionId', as: 'submission' });
User.hasMany(PipelineRun, { foreignKey: 'causedByUserId', as: 'causedRuns' });
PipelineRun.belongsTo(User, { foreignKey: 'causedByUserId', as: 'causedBy' });
PipelineRun.belongsTo(PipelineRun, { foreignKey: 'parentRunId', as: 'parent' });
PipelineRun.hasMany(PipelineRun, { foreignKey: 'parentRunId', as: 'children' });

// A run CREATED these executions...
PipelineRun.hasMany(StepExecution, { foreignKey: 'pipelineRunId', as: 'executions' });
StepExecution.belongsTo(PipelineRun, { foreignKey: 'pipelineRunId', as: 'pipelineRun' });

// ...and CONTAINS these, which is a different set: a carried-over execution is
// contained by several runs and created by exactly one.
PipelineRun.hasMany(PipelineRunStep, { foreignKey: 'pipelineRunId', as: 'steps' });
PipelineRunStep.belongsTo(PipelineRun, { foreignKey: 'pipelineRunId', as: 'pipelineRun' });
PipelineRunStep.belongsTo(StepExecution, { foreignKey: 'stepExecutionId', as: 'execution' });
StepExecution.hasMany(PipelineRunStep, { foreignKey: 'stepExecutionId', as: 'memberships' });

Submission.hasMany(SubmissionInputFreeze, { foreignKey: 'submissionId', as: 'inputFreezes' });
SubmissionInputFreeze.belongsTo(Submission, { foreignKey: 'submissionId', as: 'submission' });
File.hasMany(SubmissionInputFreeze, { foreignKey: 'fileId', as: 'freezes' });
SubmissionInputFreeze.belongsTo(File, { foreignKey: 'fileId', as: 'file' });

// (Suggestion model + associations removed — suggestions are now derived
// at read time as the diff between the Generated KRT and krt_data; only
// rejections are persisted, in rejected_resources.)

// User -> UserHiddenSubmissions (one-to-many)
User.hasMany(UserHiddenSubmission, { foreignKey: 'userId', as: 'hiddenSubmissions' });
UserHiddenSubmission.belongsTo(User, { foreignKey: 'userId', as: 'user' });

// User -> RefreshTokens (one-to-many, CASCADE delete via FK)
User.hasMany(RefreshToken, { foreignKey: 'userId', as: 'refreshTokens' });
RefreshToken.belongsTo(User, { foreignKey: 'userId', as: 'user' });

// RefreshToken -> RefreshToken self-ref for the rotation chain
RefreshToken.belongsTo(RefreshToken, { foreignKey: 'replacedBy', as: 'successor' });

// Submission -> UserHiddenSubmissions (one-to-many)
Submission.hasMany(UserHiddenSubmission, { foreignKey: 'submissionId', as: 'hiddenBy' });
UserHiddenSubmission.belongsTo(Submission, { foreignKey: 'submissionId', as: 'submission' });

module.exports = {
  sequelize,
  Sequelize,
  User,
  Team,
  UserTeam,
  Submission,
  File,
  KRTData,
  ValidationResult,
  ChangeLog,
  Report,
  UserHiddenSubmission,
  ResourceType,
  AppConfig,
  SubmissionJob,
  StepExecution,
  PipelineRun,
  PipelineRunStep,
  SubmissionInputFreeze,
  EnrichmentListEntry,
  RefreshToken,
  RejectedResource,
  TeamEmail,
  Project
};
