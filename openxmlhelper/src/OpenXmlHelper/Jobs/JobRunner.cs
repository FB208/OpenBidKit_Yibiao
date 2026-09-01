namespace Yibiao.OpenXmlHelper.Jobs;

/// <summary>按任务目录执行一个 action，一次只跑一个任务。</summary>
sealed class JobRunner
{
    readonly string _workspace;
    int _busy;

    public JobRunner(string workspace)
    {
        _workspace = workspace;
    }

    /// <summary>执行任务并写 result.json，返回是否成功。</summary>
    public bool Run(string jobId)
    {
        if (Interlocked.CompareExchange(ref _busy, 1, 0) != 0)
        {
            JobFolder.TryWriteResult(_workspace, jobId, JobResult.Fail("助手忙"));
            return false;
        }

        try
        {
            return Execute(jobId);
        }
        finally
        {
            Volatile.Write(ref _busy, 0);
        }
    }

    bool Execute(string jobId)
    {
        if (!JobFolder.TryReadRequest(_workspace, jobId, out var request, out var error))
        {
            JobFolder.TryWriteResult(_workspace, jobId, JobResult.Fail(error));
            return false;
        }

        JobResult result = request.Action switch
        {
            PingAction.Name => PingAction.Execute(),
            ListBlocksAction.Name => ListBlocksAction.Execute(_workspace, jobId),
            ExtractChaptersAction.Name => ExtractChaptersAction.Execute(_workspace, jobId),
            ScanTemplateFieldsAction.Name => ScanTemplateFieldsAction.Execute(_workspace, jobId),
            ApplyTemplateFieldsAction.Name => ApplyTemplateFieldsAction.Execute(_workspace, jobId),
            InsertBodyHtmlAction.Name => InsertBodyHtmlAction.Execute(_workspace, jobId),
            _ => JobResult.Fail($"未知动作：{request.Action}"),
        };

        if (!JobFolder.TryWriteResult(_workspace, jobId, result))
        {
            return false;
        }

        return result.Ok;
    }
}
