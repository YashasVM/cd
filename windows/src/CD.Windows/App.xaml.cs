using System.Windows;

namespace CD.Windows;

public partial class App : System.Windows.Application
{
    public App()
    {
        if (string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("windir")))
            Environment.SetEnvironmentVariable("windir", Environment.GetFolderPath(Environment.SpecialFolder.Windows));
    }

    protected override void OnSessionEnding(SessionEndingCancelEventArgs e)
    {
        (MainWindow as CD.Windows.MainWindow)?.PrepareForSystemShutdown();
        base.OnSessionEnding(e);
    }
}
