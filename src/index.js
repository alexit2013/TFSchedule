const fs = require('fs-extra');
const events = require('events');
const mysql = require('promise-mysql');
const co = require('co');
const util = require('util');
const path = require('path');

const {
    scheduleJob,
    scheduledJobs
} = require('node-schedule');

const {
    runWeb,
    webApp
} = require('./webapp');
const {
    checkTaskExecListExistsSql,
    checkTaskListExistsSql,
    clearTaskExecRecordTpl
} = require('./lib/tpl');
// const { clearTaskExecRecord } = require('./lib/clearTaskExecRecord');

const {
    bindEvent
} = require('./lib/bindEvent');
const {
    startExecTask,
    endExecTask
} = require('./lib/hook');
const {
    monitorHelper
} = require('./lib/monitorHelper');
const {
    execTask
} = require('./lib/execTask');

function TFSchedule(config) {
    var {
        backExecRecordNum,
        mysqlConfig,
        taskRootPath,
        command,
        entryFile,
        notifyList
    } = config;
    // 挂载配置并校验
    this.config = config;

    if (!(backExecRecordNum && mysqlConfig && taskRootPath && notifyList)) {
        return this.throwError('please init with enough params ，need backExecRecordNum && mysqlConfig && taskRootPath && notifyList to init');
    }
    if (!fs.existsSync(taskRootPath)) {
        return this.throwError(`${taskRootPath} directory is not exists`);
    }

    this.mysqlConfig = mysqlConfig;
    this.taskRootPath = taskRootPath;
    this.backExecRecordNum = backExecRecordNum;
    this.notifyList = notifyList;

    this.mysqlClient = null;
    this.taskRuleMap = {};
    this.scheduledJobs = scheduledJobs;
    this.childProcessHandleCache = {};

    this.command = command || 'node'; // 系统默认的执行器
    this.entryFile = entryFile || 'index.js'; // 系统默认的入口文件

    var that = this;
    co(function* () {
        yield that.init();
        yield that.bindEvent();
        yield that.startSystem();
    });
}

TFSchedule.prototype = {
    execTask,
    startExecTask,
    endExecTask,
    monitorHelper,
    bindEvent,
    init: function* () {
        // 初始化mysql连接
        try {
            this.mysqlClient = mysql.createPool(this.mysqlConfig);
        } catch (e) {
            this.throwError('init mysql failed', e);
        }
        // 检查数据库中表是否存在
        try {
            yield this.mysqlClient.query(checkTaskListExistsSql);
            yield this.mysqlClient.query(checkTaskExecListExistsSql);
        } catch (e) {
            this.throwError('check database has t_task_list,t_task_exec_list failed', e);
        }
    },
    // 系统启动函数
    startSystem: function* () {
        var {
            taskRuleMap,
            mysqlClient
        } = this;
        var that = this;

        // 1. 绑定监控小助手, 每3S运行一次
        console.log('========绑定监控小助手，3S执行一次=============');
        scheduleJob('monitorHelper', '*/3 * * * * *', () => {
            co(function* () {
                yield that.monitorHelper();
            });
        });
        // 2. 查询数据库中所有任务
        var taskListRes = yield mysqlClient.query('select taskName,rule from t_task_list');
        this.emit('notify', {
            title: `批跑系统开始启动,共有${taskListRes.length}项定时任务`,
            content: JSON.stringify(taskListRes)
        });

        // 3. 将当前数据库中的任务与规则 存储在全局对象G_task_map中,并挂载任务到定时器上
        taskListRes.forEach(({
            taskName,
            rule
        }) => {
            taskRuleMap[taskName] = rule;
            console.log(`(${taskName})-挂载定时器，按照${rule}规则定时执行`);
            scheduleJob(taskName, rule, () => {
                try {
                    that.emit('runTask', taskName);
                } catch (e) {
                    that.throwError('runTask', e);
                }
            });
        });
        yield this.setClearRecord();
    },
    // 设置清理小助手
    setClearRecord: function* () {
        var {
            config,
            taskRootPath,
            mysqlClient,
            scheduledJobs,
            notifyList
        } = this;
        try {
            const clearTaskExecRecordCode = clearTaskExecRecordTpl(config);
            const execFilePath = path.join(taskRootPath, 'clearTaskExecRecord/index.js');
            fs.ensureFileSync(execFilePath);
            fs.writeFileSync(execFilePath, clearTaskExecRecordCode);
            // 如果数据库已存在该任务，则必定已经挂载了
            const insertTaskSql = `INSERT INTO t_task_list (taskName, owner, title, description, rule, command, entryFile, taskStatus, timeout) VALUES('clearTaskExecRecord', '${notifyList}', '清理小工具', '清除日志文件与任务执行记录', '0 0 3 * * *', 'node', 'index.js', 0, 60)`;
            if (!scheduledJobs.clearTaskExecRecord) {
                yield mysqlClient.query(insertTaskSql);
            }
        } catch (e) {
            this.throwError('setClearRecord', e);
        }

    },
    throwError(errMsg, error) {
        try {
            this.emit('systemError', {
                errMsg,
                error
            });
            console.error(errMsg, error);
        } catch (e) {
            console.error('systemError', errMsg, e);
        }

    }
};
// 继承事件
util.inherits(TFSchedule, events.EventEmitter);
module.exports = {
    TFSchedule,
    runWeb,
    webApp
};
