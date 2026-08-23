using System.Windows;

namespace CD.Windows;

public partial class App : System.Windows.Application
{
    protected override void OnSessionEnding(SessionEndingCancelEventArgs e)
    {
        (MainWindow as CD.Windows.MainWindow)?.PrepareForSystemShutdown();
        base.OnSessionEnding(e);
    }
}
