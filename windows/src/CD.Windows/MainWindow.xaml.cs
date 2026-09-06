using CD.Windows.Services;
using Microsoft.Win32;
using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using Forms = System.Windows.Forms;

namespace CD.Windows;

public partial class MainWindow : Window
{
    private enum Section { Devices, Browse, Send, Receive, Clipboard, Transfers }
    private readonly ObservableCollection<SelectedFile> _files = [];
    private readonly AppSettings _settings = AppSettings.Load();
    private readonly CdxRunner _runner = new();
    private readonly CancellationTokenSource _lifetime = new();
    private readonly ClerkAuthService _auth;
    private CancellationTokenSource? _signIn;
    private CancellationTokenSource? _transfer;
    private Forms.NotifyIcon? _tray;
    private bool _sendPage = true;
    private Section _section = Section.Send;
    private bool _nearby = true;
    private bool _guest;
    private bool _initialized;
    private bool _exitRequested;

    public MainWindow(IReadOnlyList<string>? startupPaths = null)
    {
        InitializeComponent();
        _auth = new ClerkAuthService(_settings);
        FileList.ItemsSource = _files;
        DestinationTextBox.Text = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads");
        if (startupPaths is { Count: > 0 })
        {
            _section = Section.Send;
            _sendPage = true;
            _ = LoadStartupPathsAsync(startupPaths);
        }
        SourceInitialized += (_, _) => UseDarkTitleBar();
        SelfCheck();
        RefreshView();
    }

    private async Task LoadStartupPathsAsync(IReadOnlyList<string> paths)
    {
        var files = await Task.Run(() => paths.SelectMany(ExpandInputPath).Distinct(StringComparer.OrdinalIgnoreCase).ToArray());
        if (!_lifetime.IsCancellationRequested)
        {
            var initialCount = _files.Count;
            AddFiles(files);
            if (_files.Count == initialCount)
            {
                ShowStatus("No readable files were found in the supplied paths.", error: true);
            }
        }
    }

    private static IEnumerable<string> ExpandInputPath(string path)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            yield break;
        }

        string fullPath;
        try
        {
            fullPath = Path.GetFullPath(path);
        }
        catch (ArgumentException)
        {
            yield break;
        }
        catch (NotSupportedException)
        {
            yield break;
        }

        if (File.Exists(fullPath))
        {
            yield return fullPath;
            yield break;
        }

        if (!Directory.Exists(fullPath))
        {
            yield break;
        }

        string[] files;
        try
        {
            files = Directory.EnumerateFiles(fullPath, "*", SearchOption.AllDirectories).ToArray();
        }
        catch (IOException)
        {
            yield break;
        }
        catch (UnauthorizedAccessException)
        {
            yield break;
        }

        foreach (var file in files)
        {
            yield return file;
        }
    }

    private async void Window_Loaded(object sender, RoutedEventArgs e)
    {
        if (_initialized)
        {
            return;
        }

        _initialized = true;
        CreateTrayIcon();
        ExitGuestButton.Visibility = Visibility.Collapsed;
        if (!_auth.IsConfigured)
        {
            ClerkSignInButton.IsEnabled = false;
            LoginStatusText.Text = "Clerk needs an issuer and public OAuth client ID. You can still transfer as a guest.";
            return;
        }

        ClerkSignInButton.IsEnabled = false;
        LoginStatusText.Text = "Restoring your Clerk session…";
        try
        {
            var user = await _auth.RestoreAsync(_lifetime.Token);
            if (user is not null)
            {
                ShowUser(user);
                return;
            }
        }
        catch (OperationCanceledException)
        {
            return;
        }

        ClerkSignInButton.IsEnabled = true;
        LoginStatusText.Text = "Sign in with Clerk, or continue locally as a guest.";
    }

    private void SendNav_Click(object sender, RoutedEventArgs e)
    {
        _section = Section.Send;
        _sendPage = true;
        ResetResult();
        RefreshView();
    }

    private void ReceiveNav_Click(object sender, RoutedEventArgs e)
    {
        _section = Section.Receive;
        _sendPage = false;
        ResetResult();
        RefreshView();
    }

    private void DevicesNav_Click(object sender, RoutedEventArgs e) { _section = Section.Devices; RefreshView(); }
    private void BrowseNav_Click(object sender, RoutedEventArgs e) { _section = Section.Browse; RefreshView(); }
    private void ClipboardNav_Click(object sender, RoutedEventArgs e) { _section = Section.Clipboard; RefreshView(); }
    private void TransfersNav_Click(object sender, RoutedEventArgs e) { _section = Section.Transfers; RefreshView(); }
    private void EmptySectionAction_Click(object sender, RoutedEventArgs e) { _section = Section.Send; _sendPage = true; RefreshView(); }

    private void NearbyMode_Click(object sender, RoutedEventArgs e)
    {
        _nearby = true;
        ResetResult();
        RefreshView();
    }

    private void CloudMode_Click(object sender, RoutedEventArgs e)
    {
        _nearby = false;
        ResetResult();
        RefreshView();
    }

    private void AddFiles_Click(object sender, RoutedEventArgs e) => ChooseFiles();

    private void FileDrop_Click(object sender, MouseButtonEventArgs e)
    {
        if (e.ChangedButton == MouseButton.Left)
        {
            ChooseFiles();
        }
    }

    private void ChooseFiles()
    {
        var dialog = new Microsoft.Win32.OpenFileDialog
        {
            Multiselect = true,
            Title = "Choose files to send",
            CheckFileExists = true,
        };
        if (dialog.ShowDialog(this) == true)
        {
            AddFiles(dialog.FileNames);
        }
    }

    private void AddFiles(IEnumerable<string> paths)
    {
        var existing = _files.Select(file => file.Path).ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach (var path in paths.Where(File.Exists))
        {
            if (!existing.Add(path))
            {
                continue;
            }

            try
            {
                var info = new FileInfo(path);
                _files.Add(new SelectedFile(info.FullName, info.Name, info.Length, FormatBytes(info.Length)));
            }
            catch (IOException)
            {
            }
            catch (UnauthorizedAccessException)
            {
            }
        }
        RefreshFiles();
    }

    private void ClearFiles_Click(object sender, RoutedEventArgs e)
    {
        _files.Clear();
        RefreshFiles();
    }

    private void FileDrop_DragEnter(object sender, System.Windows.DragEventArgs e)
    {
        e.Effects = e.Data.GetDataPresent(System.Windows.DataFormats.FileDrop)
            ? System.Windows.DragDropEffects.Copy
            : System.Windows.DragDropEffects.None;
        FileDropBorder.BorderBrush = Brush("AccentBrush");
        e.Handled = true;
    }

    private void FileDrop_DragLeave(object sender, System.Windows.DragEventArgs e) =>
        FileDropBorder.BorderBrush = Brush("BorderBrush");

    private void FileDrop_Drop(object sender, System.Windows.DragEventArgs e)
    {
        FileDropBorder.BorderBrush = Brush("BorderBrush");
        if (e.Data.GetData(System.Windows.DataFormats.FileDrop) is string[] paths)
        {
            AddFiles(paths);
        }
    }

    private async void StartSend_Click(object sender, RoutedEventArgs e)
    {
        if (_files.Count == 0 || _transfer is not null)
        {
            ShowStatus("Choose at least one file first.", error: true);
            return;
        }
        if (!_nearby && _files.Count > 100)
        {
            ShowStatus("Cloud transfers support up to 100 files.", error: true);
            return;
        }

        _transfer = CancellationTokenSource.CreateLinkedTokenSource(_lifetime.Token);
        SetTransferActive(true);
        var progress = new Progress<TransferUpdate>(ShowUpdate);
        try
        {
            if (_nearby)
            {
                var code = GenerateCode();
                ShowResult("NEARBY TRANSFER CODE", code);
                ShowStatus("Waiting for the receiving device…");
                await _runner.SendNearbyAsync(_files.Select(file => file.Path).ToArray(), code, progress, _transfer.Token);
            }
            else
            {
                ShowStatus("Encrypting files before upload…");
                var expiration = ((ComboBoxItem)ExpirationCombo.SelectedItem).Tag?.ToString() ?? "1d";
                var downloads = int.Parse(((ComboBoxItem)DownloadsCombo.SelectedItem).Content.ToString()!, CultureInfo.InvariantCulture);
                var result = await _runner.SendCloudAsync(
                    _files.Select(file => file.Path).ToArray(),
                    _settings.StoreUrl,
                    expiration,
                    downloads,
                    progress,
                    _transfer.Token);
                ShowResult("ENCRYPTED CLOUD LINK", result.ShareLink);
            }
            ShowComplete("Transfer complete.");
        }
        catch (OperationCanceledException)
        {
            ShowStatus("Transfer cancelled.");
        }
        catch (Exception exception)
        {
            ShowStatus(exception.Message, error: true);
        }
        finally
        {
            _transfer.Dispose();
            _transfer = null;
            SetTransferActive(false);
        }
    }

    private void BrowseDestination_Click(object sender, RoutedEventArgs e)
    {
        var dialog = new OpenFolderDialog
        {
            Title = "Choose where received files are saved",
            InitialDirectory = Directory.Exists(DestinationTextBox.Text) ? DestinationTextBox.Text : null,
        };
        if (dialog.ShowDialog(this) == true)
        {
            DestinationTextBox.Text = dialog.FolderName;
        }
    }

    private async void StartReceive_Click(object sender, RoutedEventArgs e)
    {
        var value = ReceiveCodeTextBox.Text.Trim();
        if (value.Length == 0 || _transfer is not null)
        {
            ShowStatus(_nearby ? "Enter the sender's transfer code." : "Paste the encrypted cloud link.", error: true);
            return;
        }
        if (_nearby && value.Length < 6)
        {
            ShowStatus("That nearby transfer code is too short.", error: true);
            return;
        }

        string destination;
        try
        {
            destination = Path.GetFullPath(DestinationTextBox.Text.Trim());
            Directory.CreateDirectory(destination);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            ShowStatus("Choose a writable destination folder.", error: true);
            return;
        }

        _transfer = CancellationTokenSource.CreateLinkedTokenSource(_lifetime.Token);
        SetTransferActive(true);
        var progress = new Progress<TransferUpdate>(ShowUpdate);
        try
        {
            ShowStatus(_nearby ? "Looking for the sender on your network…" : "Inspecting encrypted transfer…");
            if (_nearby)
            {
                await _runner.ReceiveNearbyAsync(value, destination, progress, _transfer.Token);
            }
            else
            {
                await _runner.ReceiveCloudAsync(value, destination, progress, _transfer.Token);
            }
            ShowComplete("Files received and verified.");
        }
        catch (OperationCanceledException)
        {
            ShowStatus("Transfer cancelled.");
        }
        catch (Exception exception)
        {
            ShowStatus(exception.Message, error: true);
        }
        finally
        {
            _transfer.Dispose();
            _transfer = null;
            SetTransferActive(false);
        }
    }

    private void CancelTransfer_Click(object sender, RoutedEventArgs e)
    {
        TransferStatusText.Text = "Cancelling safely…";
        _transfer?.Cancel();
        _runner.Cancel();
    }

    private void CopyResult_Click(object sender, RoutedEventArgs e)
    {
        if (ResultValueTextBox.Text.Length == 0)
        {
            return;
        }
        try
        {
            System.Windows.Clipboard.SetText(ResultValueTextBox.Text);
            TransferStatusText.Text = "Copied to clipboard.";
        }
        catch (ExternalException)
        {
            ShowStatus("Windows could not access the clipboard. Try again.", error: true);
        }
    }

    private async void ClerkSignIn_Click(object sender, RoutedEventArgs e)
    {
        if (_signIn is not null)
        {
            return;
        }

        using var signIn = CancellationTokenSource.CreateLinkedTokenSource(_lifetime.Token);
        _signIn = signIn;
        ClerkSignInButton.IsEnabled = false;
        LoginStatusText.Text = "Finish signing in with Clerk in your browser…";
        try
        {
            var user = await _auth.SignInAsync(signIn.Token);
            signIn.Token.ThrowIfCancellationRequested();
            ShowUser(user);
        }
        catch (OperationCanceledException)
        {
            LoginStatusText.Text = "Sign-in cancelled.";
        }
        catch (Exception exception)
        {
            LoginStatusText.Text = exception.Message;
        }
        finally
        {
            _signIn = null;
            ClerkSignInButton.IsEnabled = _auth.IsConfigured;
        }
    }

    private void Guest_Click(object sender, RoutedEventArgs e)
    {
        _signIn?.Cancel();
        _guest = true;
        AccountNameText.Text = "Guest";
        AccountMetaText.Text = "Local session";
        AvatarText.Text = "G";
        LoginOverlay.Visibility = Visibility.Collapsed;
    }

    private async void Account_Click(object sender, RoutedEventArgs e)
    {
        if (_guest)
        {
            if (ReferenceEquals(sender, ExitGuestButton))
            {
                LoginOverlay.Visibility = Visibility.Collapsed;
                return;
            }
            LoginStatusText.Text = _auth.IsConfigured
                ? "Sign in with Clerk, or return to your guest session."
                : "Clerk is not configured. Return to your guest session.";
            ExitGuestButton.Content = "Back to guest session";
            ExitGuestButton.Visibility = Visibility.Visible;
            LoginOverlay.Visibility = Visibility.Visible;
            return;
        }

        if (_auth.CurrentUser is null)
        {
            LoginOverlay.Visibility = Visibility.Visible;
            return;
        }

        var answer = System.Windows.MessageBox.Show(this, "Sign out of Clerk on this device?", "CD", MessageBoxButton.YesNo, MessageBoxImage.Question);
        if (answer != MessageBoxResult.Yes)
        {
            return;
        }
        await _auth.SignOutAsync(_lifetime.Token);
        AccountNameText.Text = "Signed out";
        AccountMetaText.Text = "Clerk account";
        AvatarText.Text = "—";
        LoginStatusText.Text = "Signed out. Sign in again or continue as a guest.";
        LoginOverlay.Visibility = Visibility.Visible;
    }

    private void ShowUser(ClerkUser user)
    {
        _guest = false;
        AccountNameText.Text = user.DisplayName;
        AccountMetaText.Text = user.Email.Length > 0 ? user.Email : "Clerk account";
        var initial = user.DisplayName.FirstOrDefault(char.IsLetterOrDigit);
        AvatarText.Text = initial == default ? "C" : char.ToUpperInvariant(initial).ToString();
        LoginOverlay.Visibility = Visibility.Collapsed;
    }

    private void RefreshView()
    {
        var transferSection = _section is Section.Send or Section.Receive;
        SendPanel.Visibility = _section == Section.Send ? Visibility.Visible : Visibility.Collapsed;
        ReceivePanel.Visibility = _section == Section.Receive ? Visibility.Visible : Visibility.Collapsed;
        EmptySectionPanel.Visibility = transferSection ? Visibility.Collapsed : Visibility.Visible;
        NearbyHintPanel.Visibility = _nearby ? Visibility.Visible : Visibility.Collapsed;
        CloudOptionsPanel.Visibility = _nearby ? Visibility.Collapsed : Visibility.Visible;

        MainTitleText.Text = _section switch
        {
            Section.Devices => "Devices",
            Section.Browse => "Browse Phone",
            Section.Clipboard => "Clipboard",
            Section.Transfers => "Transfers",
            _ => _sendPage ? "Send files" : "Receive files",
        };
        MainSubtitleText.Text = !transferSection ? "This capability is not connected yet." : (_sendPage, _nearby) switch
        {
            (true, true) => "Encrypted at local-network speed.",
            (true, false) => "Upload ciphertext and share one private link.",
            (false, true) => "Receive directly from a nearby device.",
            _ => "Download, authenticate, and decrypt from the cloud.",
        };
        StartSendButton.Content = _nearby ? "Start nearby transfer" : "Create encrypted link";
        StartReceiveButton.Content = _nearby ? "Receive nearby" : "Download from cloud";
        ReceiveCodeLabel.Text = _nearby ? "Nearby transfer code" : "Encrypted cloud link or token";

        if (!transferSection)
        {
            EmptySectionTitle.Text = MainTitleText.Text;
            EmptySectionText.Text = _section switch
            {
                Section.Devices => "Pairing is not available in this build. Use Send files or Receive files with a transfer code.",
                Section.Browse => "Phone browsing requires a paired Android device. Pairing is not available in this build.",
                Section.Clipboard => "Clipboard sync is not connected. Files can still be transferred securely below.",
                _ => "Transfer history is not persisted yet. Active transfers appear in the Send and Receive sections.",
            };
            EmptySectionAction.Content = "Go to Send files";
        }

        SelectButton(DevicesNavButton, _section == Section.Devices);
        SelectButton(BrowseNavButton, _section == Section.Browse);
        SelectButton(SendNavButton, _section == Section.Send);
        SelectButton(ReceiveSubmodeButton, _section == Section.Receive);
        SelectButton(ClipboardNavButton, _section == Section.Clipboard);
        SelectButton(TransfersNavButton, _section == Section.Transfers);
        SelectButton(NearbyModeButton, _nearby);
        SelectButton(CloudModeButton, !_nearby);
        RefreshFiles();
    }

    private void RefreshFiles()
    {
        EmptyFilesText.Visibility = _files.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
        FileDropTitle.Text = _files.Count == 0 ? "Drop files here" : "Add more files";
        FileCountText.Text = $"{_files.Count} file{(_files.Count == 1 ? string.Empty : "s")}";
        FileTotalText.Text = FormatBytes(_files.Sum(file => file.Bytes));
        ClearFilesButton.IsEnabled = _files.Count > 0 && _transfer is null;
        StartSendButton.IsEnabled = _files.Count > 0 && _transfer is null;
    }

    private void SetTransferActive(bool active)
    {
        DevicesNavButton.IsEnabled = !active;
        BrowseNavButton.IsEnabled = !active;
        SendNavButton.IsEnabled = !active;
        ReceiveSubmodeButton.IsEnabled = !active;
        ClipboardNavButton.IsEnabled = !active;
        TransfersNavButton.IsEnabled = !active;
        NearbyModeButton.IsEnabled = !active;
        CloudModeButton.IsEnabled = !active;
        AddFilesButton.IsEnabled = !active;
        FileDropBorder.IsEnabled = !active;
        StartReceiveButton.IsEnabled = !active;
        ReceiveCodeTextBox.IsEnabled = !active;
        BrowseDestinationButton.IsEnabled = !active;
        CancelTransferButton.IsEnabled = active;
        EfficiencyStatusText.Text = active ? "Active transfer only" : "No background polling";
        RefreshFiles();
    }

    private void ShowUpdate(TransferUpdate update)
    {
        ShowStatus(update.Message);
        if (update.Percent is { } percent)
        {
            TransferProgressBar.IsIndeterminate = false;
            TransferProgressBar.Value = percent;
        }
        else
        {
            TransferProgressBar.IsIndeterminate = true;
        }
    }

    private void ShowStatus(string text, bool error = false)
    {
        ProgressPanel.Visibility = Visibility.Visible;
        TransferStatusText.Text = text;
        TransferStatusText.Foreground = error
            ? new SolidColorBrush(System.Windows.Media.Color.FromRgb(255, 138, 138))
            : Brush("TextBrush");
        if (error)
        {
            TransferProgressBar.IsIndeterminate = false;
        }
    }

    private void ShowComplete(string text)
    {
        ShowStatus(text);
        TransferProgressBar.IsIndeterminate = false;
        TransferProgressBar.Value = 100;
    }

    private void ShowResult(string label, string value)
    {
        ResultEyebrowText.Text = label;
        ResultValueTextBox.Text = value;
        ResultPanel.Visibility = Visibility.Visible;
    }

    private void ResetResult()
    {
        ResultPanel.Visibility = Visibility.Collapsed;
        ProgressPanel.Visibility = Visibility.Collapsed;
        ResultValueTextBox.Clear();
        TransferProgressBar.Value = 0;
        TransferProgressBar.IsIndeterminate = false;
    }

    private void SelectButton(System.Windows.Controls.Button button, bool selected)
    {
        button.Background = selected ? Brush("SurfaceRaisedBrush") : System.Windows.Media.Brushes.Transparent;
        button.Foreground = selected ? Brush("TextBrush") : Brush("MutedTextBrush");
        button.BorderBrush = selected ? Brush("BorderBrush") : System.Windows.Media.Brushes.Transparent;
    }

    private System.Windows.Media.Brush Brush(string key) => (System.Windows.Media.Brush)FindResource(key);

    private void Window_StateChanged(object? sender, EventArgs e)
    {
        if (WindowState == WindowState.Minimized)
        {
            HideToTray();
        }
    }

    private void Window_Closing(object? sender, CancelEventArgs e)
    {
        if (_exitRequested)
        {
            return;
        }
        e.Cancel = true;
        HideToTray();
    }

    private void HideToTray()
    {
        WindowState = WindowState.Normal;
        Hide();
        ShowInTaskbar = false;
    }

    private void RestoreWindow()
    {
        ShowInTaskbar = true;
        Show();
        WindowState = WindowState.Normal;
        Activate();
    }

    private void CreateTrayIcon()
    {
        var menu = new Forms.ContextMenuStrip();
        menu.Items.Add("Open CD", null, (_, _) => Dispatcher.BeginInvoke(RestoreWindow));
        menu.Items.Add(new Forms.ToolStripSeparator());
        menu.Items.Add("Exit CD", null, (_, _) => Dispatcher.BeginInvoke(ExitApplication));
        _tray = new Forms.NotifyIcon
        {
            Text = "CD — secure file transfer",
            Icon = System.Drawing.SystemIcons.Application,
            ContextMenuStrip = menu,
            Visible = true,
        };
        _tray.DoubleClick += (_, _) => Dispatcher.BeginInvoke(RestoreWindow);
    }

    private void ExitApplication()
    {
        if (_transfer is not null && System.Windows.MessageBox.Show(
            this,
            "A transfer is active. Exit and stop it?",
            "CD",
            MessageBoxButton.YesNo,
            MessageBoxImage.Warning) != MessageBoxResult.Yes)
        {
            return;
        }

        _exitRequested = true;
        _lifetime.Cancel();
        _runner.Cancel();
        if (_tray is not null)
        {
            _tray.Visible = false;
            _tray.ContextMenuStrip?.Dispose();
            _tray.Dispose();
            _tray = null;
        }
        System.Windows.Application.Current.Shutdown();
    }

    internal void PrepareForSystemShutdown()
    {
        _exitRequested = true;
        _lifetime.Cancel();
        _runner.Cancel();
    }

    private void UseDarkTitleBar()
    {
        var handle = new WindowInteropHelper(this).Handle;
        var enabled = 1;
        if (DwmSetWindowAttribute(handle, 20, ref enabled, sizeof(int)) != 0)
        {
            _ = DwmSetWindowAttribute(handle, 19, ref enabled, sizeof(int));
        }
    }

    private static string GenerateCode()
    {
        const string alphabet = "abcdefghijkmnopqrstuvwxyz";
        return string.Join("-", Enumerable.Range(0, 3).Select(_ =>
            new string(Enumerable.Range(0, 6)
                .Select(_ => alphabet[RandomNumberGenerator.GetInt32(alphabet.Length)])
                .ToArray())));
    }

    private static string FormatBytes(long bytes)
    {
        string[] units = ["B", "KB", "MB", "GB", "TB"];
        var value = (double)Math.Max(0, bytes);
        var unit = 0;
        while (value >= 1024 && unit < units.Length - 1)
        {
            value /= 1024;
            unit++;
        }
        return $"{value:0.#} {units[unit]}";
    }

    [Conditional("DEBUG")]
    private static void SelfCheck()
    {
        Debug.Assert(FormatBytes(1024) == "1 KB");
        var code = GenerateCode();
        Debug.Assert(code.Split('-') is [{ Length: 6 }, { Length: 6 }, { Length: 6 }]);
    }

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);

    private sealed record SelectedFile(string Path, string Name, long Bytes, string Size)
    {
        public override string ToString() => $"{Name}    {Size}";
    }
}
