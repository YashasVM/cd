using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;

namespace CD.Windows.Services;

public sealed record TransferUpdate(string Message, double? Percent = null);
public sealed record CloudSendResult(string ShareLink, string CliToken);

public sealed partial class CdxRunner : IAsyncDisposable
{
    private const int MaxCapturedOutput = 64 * 1024;
    private Process? _process;
    private long _lastProgressTimestamp;

    public bool IsRunning => _process is { HasExited: false };

    public Task SendNearbyAsync(
        IReadOnlyCollection<string> files,
        string code,
        IProgress<TransferUpdate> progress,
        CancellationToken cancellationToken) =>
        RunAsync(
            ["--yes", "--local", "--ignore-stdin", "--disable-clipboard", "send", "--no-web", .. files],
            new Dictionary<string, string> { ["CDX_SECRET"] = code },
            progress,
            cancellationToken);

    public Task ReceiveNearbyAsync(
        string code,
        string destination,
        IProgress<TransferUpdate> progress,
        CancellationToken cancellationToken) =>
        RunAsync(
            ["--yes", "--local", "--rename", "--out", destination],
            new Dictionary<string, string> { ["CDX_SECRET"] = code },
            progress,
            cancellationToken);

    public async Task<CloudSendResult> SendCloudAsync(
        IReadOnlyCollection<string> files,
        string storeUrl,
        string expiration,
        int downloads,
        IProgress<TransferUpdate> progress,
        CancellationToken cancellationToken)
    {
        var output = await RunAsync(
            [
                "--yes", "--ignore-stdin", "--disable-clipboard", "send", "--store",
                "--store-url", storeUrl, "--store-expiration", expiration,
                "--store-downloads", downloads.ToString(CultureInfo.InvariantCulture), .. files
            ],
            null,
            progress,
            cancellationToken);

        var link = StoredLinkRegex().Match(output).Value.TrimEnd('.', ',', ')');
        var token = StoredTokenRegex().Match(output).Value;
        if (link.Length == 0 || token.Length == 0)
        {
            throw new InvalidOperationException("The encrypted upload completed, but cdx did not return a share link.");
        }

        return new CloudSendResult(link, token);
    }

    public Task ReceiveCloudAsync(
        string tokenOrLink,
        string destination,
        IProgress<TransferUpdate> progress,
        CancellationToken cancellationToken) =>
        RunAsync(
            ["--yes", "--out", destination],
            new Dictionary<string, string> { ["CDX_STORE_TOKEN"] = tokenOrLink },
            progress,
            cancellationToken);

    public void Cancel()
    {
        try
        {
            if (IsRunning)
            {
                _process!.Kill(entireProcessTree: true);
            }
        }
        catch (InvalidOperationException)
        {
        }
    }

    private async Task<string> RunAsync(
        IReadOnlyCollection<string> arguments,
        IReadOnlyDictionary<string, string>? environment,
        IProgress<TransferUpdate> progress,
        CancellationToken cancellationToken)
    {
        if (IsRunning)
        {
            throw new InvalidOperationException("A transfer is already running.");
        }

        var startInfo = new ProcessStartInfo
        {
            FileName = FindEngine(),
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            WorkingDirectory = AppContext.BaseDirectory,
        };
        startInfo.Environment["NO_COLOR"] = "1";
        startInfo.Environment["TERM"] = "dumb";
        foreach (var argument in arguments)
        {
            startInfo.ArgumentList.Add(argument);
        }
        if (environment is not null)
        {
            foreach (var item in environment)
            {
                startInfo.Environment[item.Key] = item.Value;
            }
        }

        using var process = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
        if (!process.Start())
        {
            throw new InvalidOperationException("Could not start the cdx transfer engine.");
        }
        _process = process;

        var output = new StringBuilder();
        Interlocked.Exchange(ref _lastProgressTimestamp, 0);
        using var registration = cancellationToken.Register(Cancel);
        try
        {
            var stdout = ReadOutputAsync(process.StandardOutput, output, progress);
            var stderr = ReadOutputAsync(process.StandardError, output, progress);
            await process.WaitForExitAsync(CancellationToken.None);
            await Task.WhenAll(stdout, stderr);

            cancellationToken.ThrowIfCancellationRequested();
            if (process.ExitCode != 0)
            {
                throw new InvalidOperationException($"The transfer engine stopped with code {process.ExitCode}.");
            }

            return output.ToString();
        }
        finally
        {
            _process = null;
        }
    }

    private async Task ReadOutputAsync(
        StreamReader reader,
        StringBuilder output,
        IProgress<TransferUpdate> progress)
    {
        var buffer = new char[512];
        var line = new StringBuilder();
        while (true)
        {
            var count = await reader.ReadAsync(buffer);
            if (count == 0)
            {
                EmitLine(line.ToString(), output, progress);
                return;
            }

            for (var index = 0; index < count; index++)
            {
                var character = buffer[index];
                if (character is '\r' or '\n')
                {
                    EmitLine(line.ToString(), output, progress);
                    line.Clear();
                }
                else
                {
                    line.Append(character);
                }
            }
        }
    }

    private void EmitLine(
        string raw,
        StringBuilder output,
        IProgress<TransferUpdate> progress)
    {
        var line = AnsiRegex().Replace(raw, string.Empty).Trim();
        if (line.Length == 0)
        {
            return;
        }

        lock (output)
        {
            output.AppendLine(line);
            if (output.Length > MaxCapturedOutput * 2)
            {
                output.Remove(0, output.Length - MaxCapturedOutput);
            }
        }

        if (StoredTokenRegex().IsMatch(line) || StoredLinkRegex().IsMatch(line))
        {
            progress.Report(new TransferUpdate("Encrypted link ready.", 100));
            return;
        }

        var percentage = PercentageRegex().Match(line);
        var percent = percentage.Success && double.TryParse(percentage.Groups[1].Value, CultureInfo.InvariantCulture, out var value)
            ? Math.Clamp(value, 0, 100)
            : (double?)null;
        var now = Stopwatch.GetTimestamp();
        var previous = Interlocked.Read(ref _lastProgressTimestamp);
        if (percent == 100 || previous == 0 ||
            (Stopwatch.GetElapsedTime(previous, now) >= TimeSpan.FromMilliseconds(100) &&
             Interlocked.CompareExchange(ref _lastProgressTimestamp, now, previous) == previous))
        {
            Interlocked.Exchange(ref _lastProgressTimestamp, now);
            progress.Report(new TransferUpdate(line, percent));
        }
    }

    private static string FindEngine()
    {
        var configured = Environment.GetEnvironmentVariable("CD_CDX_PATH");
        var candidates = new[]
        {
            configured,
            Path.Combine(AppContext.BaseDirectory, "cdx.exe"),
            Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "..", "cdx", "cdx.exe")),
        };
        var engine = candidates.FirstOrDefault(path => !string.IsNullOrWhiteSpace(path) && File.Exists(path));
        return engine ?? throw new FileNotFoundException(
            "cdx.exe was not found. Run windows\\build.ps1 or set CD_CDX_PATH.");
    }

    public ValueTask DisposeAsync()
    {
        Cancel();
        _process?.Dispose();
        _process = null;
        return ValueTask.CompletedTask;
    }

    [GeneratedRegex("\\u001B\\[[0-?]*[ -/]*[@-~]")]
    private static partial Regex AnsiRegex();

    [GeneratedRegex("([0-9]+(?:\\.[0-9]+)?)%", RegexOptions.CultureInvariant)]
    private static partial Regex PercentageRegex();

    [GeneratedRegex("https?://[^\\s]+/s/[^\\s]+", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex StoredLinkRegex();

    [GeneratedRegex("(?:cdx|croc)-store-v1\\.[A-Za-z0-9._-]+", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex StoredTokenRegex();
}
